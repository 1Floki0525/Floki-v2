'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createRuntime } = require('../chat/floki-chat.cjs');
const { handleTypedText } = require('../chat/floki-live-chat-interface.cjs');
const { readChatTranscriptTail } = require('../chat/chat-transcript.cjs');
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
  getSleepConfig
} = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');

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

function looksLikeVisionQuestion(text) {
  return /\b(what|who|where|describe|tell me).{0,28}\b(see|seeing|look|looking|camera|room|around you|in front of you)\b/i.test(String(text || '')) ||
    /\bwhat do you see\b/i.test(String(text || ''));
}

async function waitForFreshVision(runtimeDir, options = {}) {
  const live = getLiveChatConfig('chat');
  const maxAgeMs = Number(options.max_age_ms || 5000);
  const waitMs = Number(options.wait_ms || Math.min(5000, live.stream_timeout_ms || 5000));
  const paths = visionRuntimePaths({ runtime_dir: runtimeDir });
  const before = readLatestPrivateObservation({ runtime_dir: runtimeDir });
  const beforeTimestamp = before && (before.created_at || before.observed_at || before.timestamp) || null;
  const requestFile = path.join(runtimeDir, 'chat-webcam-vision.refresh-request.json');
  writeJsonAtomic(requestFile, {
    id: newId('visionrefresh'),
    requested_at: nowIso(),
    before_timestamp: beforeTimestamp,
    reason: options.reason || 'direct_current_vision_question'
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const latest = readLatestPrivateObservation({ runtime_dir: runtimeDir });
    const timestamp = latest && (latest.created_at || latest.observed_at || latest.timestamp) || null;
    const age = timestamp ? Date.now() - new Date(timestamp).getTime() : Infinity;
    if (latest && latest.available === true && latest.fresh === true && age <= maxAgeMs && timestamp !== beforeTimestamp) {
      return latest;
    }
    await sleep(100);
  }
  return readLatestPrivateObservation({ runtime_dir: runtimeDir });
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

  let server = null;
  let stopping = false;
  let activeAbortController = null;
  let turnQueue = Promise.resolve();
  let lifecycle = buildFlokiLifecycleStatus();
  let lifecycleTimer = null;
  let heartbeatTimer = null;
  let visionManagedSleeping = false;
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
    shutdown_requested: false,
    hearing_start_error: null,
    vision_start_error: null
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
    const sensoryReady = sleeping || Boolean(
      audio.microphone_open &&
      audio.vad_ready &&
      audio.whisper_ready &&
      audio.piper_ready &&
      audio.playback_ready &&
      !state.hearing_start_error &&
      !state.vision_start_error
    );
    const ready = Boolean(
      state.api_ready &&
      state.brain_loaded &&
      state.memory_loaded &&
      sensoryReady &&
      !state.last_error
    );
    return Object.freeze({
      ok: !state.last_error,
      ready,
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
      type: 'sensory_experience',
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
    appendLog('ambient memory: ' + (output && output.type || 'unknown'));
    return output;
  }

  async function resolveVisionContext(text) {
    if (!looksLikeVisionQuestion(text)) return undefined;
    const current = readLatestPrivateObservation({ runtime_dir: runtimeDir });
    if (current && current.available === true && current.fresh === true) return current;
    return waitForFreshVision(runtimeDir, { reason: 'spoken_or_typed_vision_question' });
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
        state.state = lifecycle.is_awake === false ? 'sleeping' : 'listening';
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
    initial_awake: lifecycle.is_awake === true,
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

    try {
      await liveAudio.setAwake(awake);
      state.hearing_start_error = null;
    } catch (error) {
      state.hearing_start_error = error.message;
      appendLog('hearing lifecycle reconcile failed: ' + error.message);
    }

    state.state = awake
      ? (state.active_turn ? 'thinking' : liveAudio.status().speaking ? 'speaking' : 'listening')
      : 'sleeping';

    if (!awake) {
      visionManagedSleeping = true;
      try {
        const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
        if (vision.active === true || vision.camera_open === true) {
          await stopChatWebcamVisionService({ runtime_dir: runtimeDir, stop_tunnel: false });
          appendLog('vision paused for sleep');
        }
        state.vision_start_error = null;
      } catch (error) {
        state.vision_start_error = error.message;
        appendLog('vision sleep pause failed: ' + error.message);
      }
    } else {
      visionManagedSleeping = false;
      try {
        const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
        if (vision.active !== true || vision.camera_open !== true) {
          await startChatWebcamVisionService({ runtime_dir: runtimeDir });
          appendLog('vision enabled for awake state');
        }
        state.vision_start_error = null;
      } catch (error) {
        state.vision_start_error = error.message;
        appendLog('vision wake start failed: ' + error.message);
      }
    }
    publish();
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
    if (req.method === 'POST' && url.pathname === '/interrupt') {
      if (activeAbortController) activeAbortController.abort();
      sendJson(res, 200, { ok: true, interrupted: Boolean(activeAbortController) });
      return;
    }
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
    state.state = lifecycle.is_awake === true ? 'listening' : 'sleeping';
    publish();
    heartbeatTimer = setInterval(() => publish(), heartbeatMs);
    lifecycleTimer = setInterval(() => {
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
  looksLikeVisionQuestion,
  waitForFreshVision,
  createChatLocalRuntime
};
