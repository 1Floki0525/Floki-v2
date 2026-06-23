'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createRuntime } = require('../chat/floki-chat.cjs');
const { handleTypedText } = require('../chat/floki-live-chat-interface.cjs');
const { assertPublicTranscriptText, appendChatTranscriptTurn, readChatTranscriptTail, clearChatTranscript } = require('../chat/chat-transcript.cjs');
const { buildFlokiLifecycleStatus } = require('../chat/floki-lifecycle-status.cjs');
const {
  readChatWebcamVisionStatus,
  readLatestPrivateObservation,
  startChatWebcamVisionService,
  stopChatWebcamVisionService,
  runtimePaths: visionRuntimePaths
} = require('../vision/chat-webcam-vision-service.cjs');
const { createBrainEvent } = require('../brain/brain-event-schema.cjs');
const { createLiveAudioService } = require('../senses/live-audio-service.cjs');
const {
  PROJECT_ROOT: ROOT,
  getAudioConfig,
  getLiveChatConfig,
  getModelConfig,
  getPathConfig,
  getSleepConfig,
  getVisionConfig
} = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');
const { getInterfaceSettings } = require('../config/interface-settings.cjs');
const { readManualNapState, beginManualNap, wakeManualNap, claimDueRemCycle, finishRemCycle } = require('../chat/manual-nap.cjs');
const { runDreamEngineOnce } = require('../chat/dream-engine.cjs');

const DEFAULT_HOST = getLiveChatConfig('chat').runtime_host;
const DEFAULT_PORT = getLiveChatConfig('chat').runtime_port;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, filePath);
}

function bodyJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('invalid JSON request: ' + error.message));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'access-control-allow-origin': 'http://127.0.0.1',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function memoryPathsWritable() {
  const candidates = [
    path.join(ROOT, 'state/floki/memories'),
    path.join(ROOT, 'state/floki/chat/interface'),
    path.join(ROOT, 'state/floki')
  ];
  try {
    for (const dir of candidates) {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeIntentText(value) {
  const lower = String(value || '').toLowerCase();
  let out = '';
  let previousSpace = true;
  for (const character of lower) {
    const code = character.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 97 && code <= 122);
    if (alphaNumeric) {
      out += character;
      previousSpace = false;
    } else if (!previousSpace) {
      out += ' ';
      previousSpace = true;
    }
  }
  return out.trim();
}

function configuredVisionQuestionPhrases(visionConfig = getVisionConfig('chat')) {
  const configured = visionConfig && visionConfig.direct_question_phrases;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return [];
  return Object.values(configured)
    .map(normalizeIntentText)
    .filter(Boolean);
}

function looksLikeVisionQuestion(text, visionConfig = getVisionConfig('chat')) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return configuredVisionQuestionPhrases(visionConfig)
    .some((phrase) => normalized.includes(phrase));
}

function visionObservationTimestamp(visionContext) {
  if (!visionContext || typeof visionContext !== 'object') return null;
  return visionContext.latest_private_observation_timestamp ||
    visionContext.created_at ||
    visionContext.observed_at ||
    visionContext.timestamp ||
    null;
}

function buildGroundedVisionReply(visionContext, visionConfig = getVisionConfig('chat')) {
  const available = Boolean(
    visionContext &&
    visionContext.available === true &&
    visionContext.fresh === true &&
    typeof visionContext.observation_summary === 'string' &&
    visionContext.observation_summary.trim()
  );
  if (!available) {
    return assertPublicTranscriptText(
      visionConfig.direct_answer_unavailable_reply,
      'configured unavailable vision reply'
    );
  }
  const prefix = String(visionConfig.direct_answer_prefix || '');
  const summary = String(visionContext.observation_summary || '').trim();
  return assertPublicTranscriptText(prefix + summary, 'grounded live vision reply');
}

async function waitForFreshVision(runtimeDir, options = {}) {
  const vision = getVisionConfig('chat');
  const maxAgeMs = Number(options.max_age_ms || vision.direct_answer_max_age_ms);
  const waitMs = Number(options.wait_ms || vision.direct_answer_wait_ms);
  const preferDetection = options.prefer_detection === true;
  const paths = visionRuntimePaths({ runtime_dir: runtimeDir });
  const before = readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    max_age_ms: maxAgeMs,
    prefer_detection: preferDetection
  });
  const beforeTimestamp = visionObservationTimestamp(before);
  const requestFile = path.join(runtimeDir, 'chat-webcam-vision.refresh-request.json');
  writeJsonAtomic(requestFile, {
    id: newId('visionrefresh'),
    requested_at: nowIso(),
    before_timestamp: beforeTimestamp,
    reason: options.reason || 'direct_current_vision_question'
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const latest = readLatestPrivateObservation({
      runtime_dir: runtimeDir,
      max_age_ms: maxAgeMs,
      prefer_detection: preferDetection
    });
    const timestamp = visionObservationTimestamp(latest);
    const age = timestamp ? Date.now() - new Date(timestamp).getTime() : Infinity;
    if (latest && latest.available === true && latest.fresh === true && age <= maxAgeMs && timestamp !== beforeTimestamp) {
      return latest;
    }
    await sleep(100);
  }
  return readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    max_age_ms: maxAgeMs,
    prefer_detection: preferDetection
  });
}

function createChatLocalRuntime(options = {}) {
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(ROOT, paths.chat_runtime_root);
  const pidFile = path.join(runtimeDir, 'chat-local-runtime.pid');
  const statusFile = path.join(runtimeDir, 'chat-local-runtime.status.json');
  const heartbeatFile = path.join(runtimeDir, 'chat-local-runtime.heartbeat.json');
  const logFile = path.join(runtimeDir, 'chat-local-runtime.log');
  const liveConfig = getLiveChatConfig('chat');
  const sleepConfig = getSleepConfig('chat');
  const host = options.host || liveConfig.runtime_host || DEFAULT_HOST;
  const port = Number(options.port || liveConfig.runtime_port || DEFAULT_PORT);
  const heartbeatMs = Number(liveConfig.runtime_heartbeat_ms);
  const lifecyclePollMs = Number(sleepConfig.lifecycle_status_poll_ms);
  const brain = options.runtime || createRuntime({ session_id: options.session_id || newId('chatruntime') });
  const model = getModelConfig('chat').cognition;
  const audioConfig = getAudioConfig('chat');
  const visionConfig = getVisionConfig('chat');

  let server = null;
  let stopping = false;
  let activeAbortController = null;
  let turnQueue = Promise.resolve();
  let lifecycle = buildFlokiLifecycleStatus();
  let lifecycleTimer = null;
  let heartbeatTimer = null;
  let visionManagedSleeping = false;
  let manualNapDreamTask = null;
  let lastManualNapActive = false;
  const startedAt = Date.now();

  const state = {
    marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_STATUS',
    state: 'starting',
    started_at: nowIso(),
    last_heartbeat_at: null,
    last_error: null,
    brain_loaded: true,
    memory_loaded: memoryPathsWritable(),
    active_turn: false,
    last_turn_started_at: null,
    last_turn_completed_at: null,
    last_turn_modality: null,
    last_reply: '',
    api_ready: false,
    client_ready: false,
    client_ready_at: null,
    client_detached_at: null,
    senses_enabled: false,
    shutdown_requested: false,
    hearing_start_error: null,
    vision_start_error: null,
    last_grounded_vision_reply_at: null,
    last_grounded_vision_source: null,
    last_grounded_vision_observation_at: null,
    last_grounded_vision_available: null,
    push_to_talk_active: false
  };

  function appendLog(message) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.appendFileSync(logFile, '[' + nowIso() + '] ' + String(message || '') + '\n');
  }

  function status(extra = {}) {
    const audio = liveAudio.status();
    const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
    lifecycle = buildFlokiLifecycleStatus();
    const sleeping = lifecycle && lifecycle.is_awake === false;
    const awaitingClient = state.client_ready !== true;
    const sensesAllowed = !sleeping && !awaitingClient;
    const hearingReady = Boolean(
      sensesAllowed &&
      audio.microphone_open &&
      audio.vad_ready &&
      audio.whisper_ready &&
      audio.piper_ready &&
      audio.playback_ready &&
      !audio.last_error &&
      !audio.last_wake_gate_error &&
      !state.hearing_start_error
    );
    const visionReady = Boolean(
      sensesAllowed &&
      vision.active === true &&
      vision.camera_open === true &&
      vision.first_frame_received === true &&
      vision.ready_for_chat === true &&
      !state.vision_start_error
    );
    const degradedReasons = [];
    if (sensesAllowed && state.hearing_start_error) degradedReasons.push('hearing_start: ' + state.hearing_start_error);
    if (sensesAllowed && audio.last_error) degradedReasons.push('hearing_runtime: ' + audio.last_error);
    if (sensesAllowed && audio.last_wake_gate_error) degradedReasons.push('wake_gate: ' + audio.last_wake_gate_error);
    if (sensesAllowed && state.vision_start_error) degradedReasons.push('vision_start: ' + state.vision_start_error);
    if (sensesAllowed && !hearingReady && degradedReasons.length === 0) degradedReasons.push('hearing_not_ready');
    if (sensesAllowed && !visionReady && degradedReasons.length === 0) degradedReasons.push('vision_not_ready');
    const sensoryReady = awaitingClient || sleeping || (hearingReady && visionReady);
    const ready = Boolean(
      state.api_ready &&
      state.brain_loaded &&
      state.memory_loaded &&
      sensoryReady &&
      !state.last_error &&
      degradedReasons.length === 0
    );
    return Object.freeze({
      ok: !state.last_error && (!sensesAllowed || degradedReasons.length === 0),
      ready,
      awaiting_client: awaitingClient,
      senses_allowed: sensesAllowed,
      hearing_ready: hearingReady,
      vision_ready: visionReady,
      hearing_intentionally_suspended: sleeping || awaitingClient,
      vision_intentionally_suspended: sleeping || awaitingClient,
      sensory_suspension_reason: sleeping ? 'sleeping' : awaitingClient ? 'interface_not_ready' : null,
      degraded_reasons: degradedReasons,
      marker: state.marker,
      pid: process.pid,
      host,
      port,
      uptime_ms: Date.now() - startedAt,
      session_id: brain.session_id,
      cognition_model: model.model,
      mode: 'chat.local',
      ...state,
      lifecycle,
      hearing: audio,
      vision: {
        active: vision.active === true,
        ready: vision.ready_for_chat === true,
        camera_open: vision.camera_open === true,
        first_frame_received: vision.first_frame_received === true,
        latest_observation_at: vision.latest_private_observation_timestamp || null,
        last_error: vision.last_fatal_error || vision.last_vlm_error || vision.last_yolo_error || null
      },
      ...extra
    });
  }

  function publish(extra = {}) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    state.last_heartbeat_at = nowIso();
    const payload = status(extra);
    writeJsonAtomic(statusFile, payload);
    const heartbeat = { pid: process.pid, created_at: state.last_heartbeat_at, state: payload.state, ready: payload.ready };
    writeJsonAtomic(heartbeatFile, heartbeat);
    return payload;
  }

  async function rememberAmbient(record) {
    const hippocampus = brain.requireModule('hippocampus');
    const summary = record.type === 'ambient_speech'
      ? 'I heard ambient speech nearby: ' + String(record.text || '').trim()
      : 'I heard ' + String(record.label || record.type || 'an ambient sound') + ' nearby.';
    const event = createBrainEvent({
      type: 'system_text',
      source: 'system',
      modality: 'text',
      created_at: record.captured_at || nowIso(),
      payload: {
        text: summary,
        sensory_modality: 'audio',
        source_type: record.source_type || 'ambient_unknown',
        addressed_to_floki: false,
        original_event_id: record.id || null
      },
      provenance: {
        observed_by: 'live_audio_service',
        confidence: typeof record.confidence === 'number' ? record.confidence : 0.65,
        notes: 'Live ambient hearing; not a direct user command.'
      }
    });
    const output = hippocampus.safeRememberEvent(event, {
      stream: 'short_term',
      type: 'experience',
      tags: ['audio', 'ambient', record.type || 'sound', record.source_type || 'unknown_source'],
      importance: record.type === 'ambient_speech' ? 0.35 : 0.25,
      content: {
        summary,
        detail: JSON.stringify({
          source_type: record.source_type || null,
          provenance: record.provenance || null,
          utterance_id: record.utterance_id || null,
          captured_at: record.captured_at || null
        })
      }
    });
    if (!output || output.type === 'failure') {
      const code = output && output.failure && output.failure.code || 'UNKNOWN';
      const message = output && output.failure && output.failure.message || 'ambient memory write failed';
      appendLog('ambient memory rejected: ' + code + ': ' + message);
      throw new Error(code + ': ' + message);
    }
    appendLog('ambient memory: ' + output.type);
    return output;
  }

  function rememberGroundedVisionTurn(request, visionContext, reply) {
    try {
      const hippocampus = brain.requireModule('hippocampus');
      const event = createBrainEvent({
        type: 'system_text',
        source: 'system',
        modality: 'text',
        created_at: nowIso(),
        payload: {
          text: 'I answered a direct sight question from my current webcam observation: ' + reply,
          sensory_modality: 'vision',
          source_type: visionContext && visionContext.source || 'webcam_unavailable',
          addressed_to_floki: true,
          user_text: request.transcript_user_text || request.cognition_text
        },
        provenance: {
          observed_by: 'chat_local_runtime_grounded_vision',
          confidence: visionContext && visionContext.available === true ? 0.95 : 1,
          notes: 'Direct sensory answer used the current structured webcam observation without model invention.'
        }
      });
      return hippocampus.safeRememberEvent(event, {
        stream: 'short_term',
        type: 'sensory_experience',
        tags: ['vision', 'webcam', 'direct_question', 'grounded_reply'],
        importance: 0.55,
        content: {
          summary: reply,
          detail: JSON.stringify({
            source: visionContext && visionContext.source || null,
            observed_at: visionContext && visionContext.latest_private_observation_timestamp || null,
            available: visionContext && visionContext.available === true
          })
        }
      });
    } catch (error) {
      appendLog('grounded vision memory failed: ' + error.message);
      return null;
    }
  }

  async function resolveVisionContext(text) {
    if (!looksLikeVisionQuestion(text, visionConfig)) return undefined;
    const readOptions = {
      runtime_dir: runtimeDir,
      max_age_ms: visionConfig.direct_answer_max_age_ms,
      prefer_detection: visionConfig.direct_answer_prefer_detection === true
    };
    const current = readLatestPrivateObservation(readOptions);
    if (current && current.available === true && current.fresh === true) return current;
    return waitForFreshVision(runtimeDir, {
      reason: 'spoken_or_typed_vision_question',
      max_age_ms: visionConfig.direct_answer_max_age_ms,
      wait_ms: visionConfig.direct_answer_wait_ms,
      prefer_detection: visionConfig.direct_answer_prefer_detection === true
    });
  }

  function recordGroundedVisionTurn(request, visionContext) {
    const reply = buildGroundedVisionReply(visionContext, visionConfig);
    const source = request.source || 'chat_local_runtime';
    appendChatTranscriptTurn({
      role: 'user',
      text: String(request.transcript_user_text || request.cognition_text),
      input_modality: request.input_modality || 'text',
      output_modality: 'none',
      spoken_aloud: false,
      source
    });
    appendChatTranscriptTurn({
      role: 'floki',
      text: reply,
      input_modality: request.input_modality || 'text',
      output_modality: request.output_modality || 'text',
      spoken_aloud: request.spoken_aloud === true,
      source: 'grounded_live_vision'
    });
    rememberGroundedVisionTurn(request, visionContext, reply);
    state.last_reply = reply;
    state.last_turn_completed_at = nowIso();
    state.last_grounded_vision_reply_at = state.last_turn_completed_at;
    state.last_grounded_vision_source = visionContext && visionContext.source || null;
    state.last_grounded_vision_observation_at = visionContext && visionContext.latest_private_observation_timestamp || null;
    state.last_grounded_vision_available = visionContext && visionContext.available === true;
    appendLog(
      'grounded vision reply source=' + String(state.last_grounded_vision_source || 'unavailable') +
      ' observation_at=' + String(state.last_grounded_vision_observation_at || 'none')
    );
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_GROUNDED_LIVE_VISION_REPLY',
      reply,
      grounded_live_vision: true,
      vision_available: state.last_grounded_vision_available,
      vision_source: state.last_grounded_vision_source,
      vision_observation_at: state.last_grounded_vision_observation_at,
      transcript_recorded_now: true,
      latency_events: []
    });
  }

  function enqueueTurn(request) {
    const task = async () => {
      if (stopping) throw new Error('chat.local runtime is stopping');
      state.active_turn = true;
      state.state = 'thinking';
      state.last_turn_started_at = nowIso();
      state.last_turn_modality = request.input_modality || 'text';
      activeAbortController = new AbortController();
      publish();
      try {
        const visionContext = await resolveVisionContext(request.cognition_text);
        if (
          visionConfig.direct_answer_enabled === true &&
          looksLikeVisionQuestion(request.cognition_text, visionConfig)
        ) {
          return recordGroundedVisionTurn(request, visionContext);
        }
        const result = await handleTypedText(brain, request.cognition_text, {
          signal: activeAbortController.signal,
          input_modality: request.input_modality || 'text',
          output_modality: request.output_modality || 'text',
          spoken_aloud: request.spoken_aloud === true,
          source: request.source || 'chat_local_runtime',
          transcript_user_text: request.transcript_user_text || request.cognition_text,
          chat_webcam_vision: visionContext,
          print_public_text: false
        });
        if (!result || result.ok !== true) throw new Error(result && result.error || 'brain response failed');
        state.last_reply = result.reply || '';
        state.last_turn_completed_at = nowIso();
        return result;
      } finally {
        activeAbortController = null;
        state.active_turn = false;
        state.state = lifecycle.is_awake === false
          ? 'sleeping'
          : state.client_ready
            ? 'listening'
            : 'awaiting_client';
        publish();
      }
    };
    const scheduled = turnQueue.then(task, task);
    turnQueue = scheduled.catch(() => {});
    return scheduled;
  }

  const liveAudio = createLiveAudioService({
    runtime_dir: runtimeDir,
    session_id: brain.session_id,
    audio_config: audioConfig,
    initial_awake: false,
    on_ambient_observation: rememberAmbient,
    async on_direct_speech(input) {
      const acceptedAt = nowIso();
      const result = await enqueueTurn({
        cognition_text: input.request_text,
        transcript_user_text: input.raw_text,
        input_modality: 'spoken',
        output_modality: 'spoken',
        spoken_aloud: true,
        source: 'live_audio_service'
      });
      appendLog('spoken turn ' + input.utterance_id + ' accepted_at=' + acceptedAt + ' completed_at=' + nowIso());
      return result;
    }
  });

  async function applyLifecycle(next) {
    lifecycle = next;
    const awake = next && next.is_awake === true;
    const voice = getInterfaceSettings('chat').voice;
    const hearingEnabled = awake && state.client_ready === true && voice.microphoneEnabled === true && (voice.pushToTalk === true ? state.push_to_talk_active === true : voice.handsFreeListening === true);
    const visionEnabled = awake && state.client_ready === true;
    state.senses_enabled = hearingEnabled || visionEnabled;

    try {
      await liveAudio.setAwake(hearingEnabled);
      state.hearing_start_error = null;
    } catch (error) {
      state.hearing_start_error = error.message;
      appendLog('hearing lifecycle reconcile failed: ' + error.message);
    }

    if (!visionEnabled) {
      visionManagedSleeping = !awake;
      try {
        const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
        if (vision.active === true || vision.camera_open === true) {
          await stopChatWebcamVisionService({ runtime_dir: runtimeDir, stop_tunnel: false });
          appendLog(awake ? 'vision paused until interface ready' : 'vision paused for sleep');
        }
        state.vision_start_error = null;
      } catch (error) {
        state.vision_start_error = error.message;
        appendLog('vision suspension failed: ' + error.message);
      }
    } else {
      visionManagedSleeping = false;
      try {
        const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
        if (vision.active !== true || vision.camera_open !== true) {
          await startChatWebcamVisionService({ runtime_dir: runtimeDir });
          appendLog('vision enabled after interface ready');
        }
        state.vision_start_error = null;
      } catch (error) {
        state.vision_start_error = error.message;
        appendLog('vision awake start failed: ' + error.message);
      }
    }

    const audioStatus = liveAudio.status();
    state.state = !awake
      ? 'sleeping'
      : state.client_ready !== true
        ? 'awaiting_client'
        : (state.hearing_start_error || state.vision_start_error || audioStatus.last_error || audioStatus.last_wake_gate_error)
          ? 'degraded'
          : state.active_turn
            ? 'thinking'
            : audioStatus.speaking
              ? 'speaking'
              : 'listening';
    publish();
  }

  async function requestManualNap() {
    const consolidation = brain.requireModule('hippocampus').consolidateShortTerm();
    const nap = beginManualNap({ consolidation });
    lastManualNapActive = true;
    await applyLifecycle(buildFlokiLifecycleStatus());
    const snapshot = status();
    const verified = snapshot.lifecycle.manual_nap_active === true && snapshot.lifecycle.manual_nap_duration_minutes === 30 && snapshot.hearing.microphone_open === false && snapshot.vision.camera_open === false;
    return Object.freeze({ ok: verified, verified, marker: verified ? 'FLOKI_V22_MANUAL_NAP_REQUEST_PASS' : 'FLOKI_V22_MANUAL_NAP_REQUEST_FAIL', nap, consolidation, status: snapshot });
  }
  async function wakeFromManualNap() {
    const nap = wakeManualNap('manual_wake'); lastManualNapActive = false; await applyLifecycle(buildFlokiLifecycleStatus());
    return Object.freeze({ ok: nap.active !== true, verified: nap.active !== true, marker: 'FLOKI_V22_MANUAL_NAP_WAKE_PASS', nap, status: status() });
  }
  async function processManualNap() {
    const nap = readManualNapState();
    if (!nap || nap.active !== true) { if (lastManualNapActive) { lastManualNapActive = false; await applyLifecycle(buildFlokiLifecycleStatus()); } return; }
    lastManualNapActive = true; if (manualNapDreamTask) return; const claim = claimDueRemCycle(); if (!claim) return;
    manualNapDreamTask = runDreamEngineOnce({ sleep_kind: 'manual_nap', env: { ...process.env, FLOKI_ALLOW_DREAM_ENGINE: '1' }, rem_cycle_number: claim.cycle.cycle_number, sleep_window_start: claim.state.started_at, sleep_window_end: claim.state.wake_at }).then((result) => finishRemCycle(result, null)).catch((error) => { finishRemCycle(null, error); appendLog('manual nap REM failed: ' + error.message); }).finally(async () => { manualNapDreamTask = null; await applyLifecycle(buildFlokiLifecycleStatus()); });
  }

  async function route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': 'http://127.0.0.1',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://' + host + ':' + String(port));
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      sendJson(res, 200, status());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/transcript') {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 200)));
      sendJson(res, 200, { ok: true, entries: readChatTranscriptTail(limit) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/client-ready') {
      state.client_ready = true;
      state.client_ready_at = nowIso();
      state.client_detached_at = null;
      appendLog('interface ready; reconciling awake sensory services');
      await applyLifecycle(buildFlokiLifecycleStatus());
      sendJson(res, 200, { ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_CLIENT_READY_PASS', status: status() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/client-detached') {
      state.client_ready = false;
      state.client_detached_at = nowIso();
      appendLog('interface detached; suspending external senses');
      await applyLifecycle(buildFlokiLifecycleStatus());
      sendJson(res, 200, { ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_CLIENT_DETACHED_PASS', status: status() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/transcript/clear') {
      const result = clearChatTranscript();
      appendLog('visible chat transcript cleared; entries=' + String(result.entries_cleared));
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await bodyJson(req);
      const text = String(body.text || '').trim();
      if (!text) throw new Error('message text is required');
      const result = await enqueueTurn({
        cognition_text: text,
        transcript_user_text: text,
        input_modality: 'text',
        output_modality: 'text',
        spoken_aloud: false,
        source: 'electron_chat'
      });
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') { const hadTurn = Boolean(activeAbortController); if (activeAbortController) activeAbortController.abort(); const speech = liveAudio.interruptSpeech(); sendJson(res, 200, { ok: true, interrupted: hadTurn || speech.interrupted === true, speech }); return; }
    if (req.method === 'POST' && url.pathname === '/nap/request') { sendJson(res, 200, await requestManualNap()); return; }
    if (req.method === 'POST' && url.pathname === '/nap/wake') { sendJson(res, 200, await wakeFromManualNap()); return; }
    if (req.method === 'GET' && url.pathname === '/nap/status') { sendJson(res, 200, { ok: true, nap: readManualNapState(), lifecycle: buildFlokiLifecycleStatus() }); return; }
    if (req.method === 'POST' && url.pathname === '/settings/reload') { await applyLifecycle(buildFlokiLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, settings: getInterfaceSettings('chat'), status: status() }); return; }
    if (req.method === 'POST' && url.pathname === '/audio/push-to-talk') { const body = await bodyJson(req); state.push_to_talk_active = body.active === true; await applyLifecycle(buildFlokiLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, active: state.push_to_talk_active, status: status() }); return; }
    if (req.method === 'POST' && url.pathname === '/speak') {
      const body = await bodyJson(req);
      const text = String(body.text || '').trim();
      if (!text) throw new Error('speech text is required');
      const result = await liveAudio.speak(text, { source: 'runtime_api' });
      sendJson(res, 200, { ok: true, result });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  async function start() {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid) + '\n');
    state.state = 'starting';
    publish();

    lifecycle = buildFlokiLifecycleStatus();
    try {
      await liveAudio.start();
      state.hearing_start_error = null;
    } catch (error) {
      state.hearing_start_error = error.message;
      appendLog('hearing startup degraded: ' + error.message);
    }
    await applyLifecycle(lifecycle);

    server = http.createServer((req, res) => {
      route(req, res).catch((error) => {
        appendLog('request error: ' + error.stack);
        sendJson(res, 500, { ok: false, error: error.message });
      });
    });
    server.on('error', (error) => {
      state.last_error = error.message;
      publish();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    state.api_ready = true;
    const startupAudio = liveAudio.status();
    state.state = lifecycle.is_awake !== true
      ? 'sleeping'
      : state.client_ready !== true
        ? 'awaiting_client'
        : (state.hearing_start_error || state.vision_start_error || startupAudio.last_error || startupAudio.last_wake_gate_error)
          ? 'degraded'
          : 'listening';
    publish();
    heartbeatTimer = setInterval(() => publish(), heartbeatMs);
    lifecycleTimer = setInterval(() => {
      void processManualNap().catch((error) => appendLog('manual nap processing failed: ' + error.message));
      const next = buildFlokiLifecycleStatus();
      void applyLifecycle(next).catch((error) => {
        state.last_error = 'lifecycle reconciliation failed: ' + error.message;
        appendLog(state.last_error);
        publish();
      });
    }, lifecyclePollMs);
    appendLog('runtime ready on http://' + host + ':' + String(port));
    return status();
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    state.client_ready = false;
    state.senses_enabled = false;
    state.shutdown_requested = true;
    state.state = 'stopping';
    publish();
    if (activeAbortController) activeAbortController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    await liveAudio.stop();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(pidFile, { force: true });
    state.api_ready = false;
    state.state = 'stopped';
    publish();
    appendLog('runtime stopped');
  }

  return Object.freeze({
    start,
    stop,
    status,
    publish,
    enqueueTurn,
    liveAudio,
    paths: Object.freeze({ runtime_dir: runtimeDir, pid_file: pidFile, status_file: statusFile, heartbeat_file: heartbeatFile, log_file: logFile })
  });
}

async function main() {
  if (!process.version.startsWith('v24.')) {
    throw new Error('Node 24 required, got ' + process.version);
  }
  const runtime = createChatLocalRuntime();
  const stop = async () => {
    try { await runtime.stop(); } finally { process.exit(0); }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const result = await runtime.start();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_FAIL', error: error.stack || error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  memoryPathsWritable,
  normalizeIntentText,
  configuredVisionQuestionPhrases,
  looksLikeVisionQuestion,
  buildGroundedVisionReply,
  visionObservationTimestamp,
  waitForFreshVision,
  createChatLocalRuntime
};
