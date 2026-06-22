'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT, getAudioConfig, getPathConfig, getTimeoutConfig } = require('../config/floki-config.cjs');
const { classifyWakeInput, shouldRouteToCognition } = require('../chat/wake-word-gate.cjs');
const { createLiveWhisperService, parseWhisperText, whisperModelPath, WHISPER_CLI, WHISPER_MODEL_DIR } = require('./live-whisper-service.cjs');
const { createLivePiperService } = require('./live-piper-service.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');

const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const PYTHON = path.join(TOOLS_DIR, 'venv-chat-embodiment', 'bin', 'python');
const VAD_WORKER = path.join(__dirname, 'silero-vad-worker.py');

function commandPath(command) {
  const result = spawnSync('bash', ['-lc', 'command -v ' + command], { encoding: 'utf8', timeout: getTimeoutConfig('chat').command_check_ms });
  return result.status === 0 ? String(result.stdout || '').trim() || null : null;
}

function fileExecutable(filePath) {
  try { fs.accessSync(filePath, fs.constants.X_OK); return true; } catch (_error) { return false; }
}

function writeWavPcm16(filePath, pcm, sampleRate, channels) {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function pcmRms(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(frame.length / 2);
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const value = frame.readInt16LE(offset) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}

function classifyLiveHeardText(heard, speaking = false) {
  return classifyWakeInput({
    text: String(heard || ''),
    modality: 'spoken',
    source: 'user',
    voice_speaking: speaking === true
  });
}

function createLiveAudioService(options = {}) {
  const audio = options.audio_config || getAudioConfig('chat');
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(ROOT, paths.chat_runtime_root);
  const tempDir = path.join(runtimeDir, 'audio-tmp');
  const statusFile = path.join(runtimeDir, 'live-audio.status.json');
  const heartbeatFile = path.join(runtimeDir, 'live-audio.heartbeat.json');
  const eventsFile = path.join(runtimeDir, 'ambient-audio-events.jsonl');
  const arecord = commandPath('arecord');

  const sampleRate = Number(audio.mic_rate || 16000);
  const channels = Number(audio.mic_channels || 1);
  const frameSamples = Number(audio.vad_frame_samples || 512);
  const frameBytes = frameSamples * channels * 2;
  const frameMs = frameSamples / sampleRate * 1000;
  const preRollFrames = Math.max(1, Math.ceil(Number(audio.pre_roll_ms || 1600) / frameMs));
  const postRollFrames = Math.max(0, Math.ceil(Number(audio.post_roll_ms || 320) / frameMs));
  const startFrames = Math.max(1, Number(audio.vad_start_frames || 2));
  const endFrames = Math.max(1, Number(audio.vad_end_frames || 15));
  const startThreshold = Number(audio.vad_start_threshold || 0.55);
  const endThreshold = Number(audio.vad_end_threshold || 0.35);
  const maxUtteranceFrames = Math.max(1, Math.ceil(Number(audio.max_utterance_seconds || 30) * 1000 / frameMs));
  const ambientStartRms = Number(audio.ambient_rms_start_threshold || 0.035);
  const ambientEndRms = Number(audio.ambient_rms_end_threshold || 0.018);
  const ambientStartFrames = Math.max(1, Number(audio.ambient_start_frames || 3));
  const ambientEndFrames = Math.max(1, Number(audio.ambient_end_frames || 20));
  const maxAmbientFrames = Math.max(1, Math.ceil(Number(audio.ambient_max_event_seconds || 12) * 1000 / frameMs));
  const minAmbientFrames = Math.max(1, Math.ceil(Number(audio.ambient_min_event_ms || 500) / frameMs));
  const attentionScanEnabled = audio.attention_scan_enabled === true;
  const attentionWindowFrames = Math.max(1, Math.ceil(Number(audio.attention_scan_window_ms) / frameMs));
  const attentionIntervalMs = Math.max(frameMs, Number(audio.attention_scan_interval_ms));
  const attentionFollowupIntervalMs = Math.max(frameMs, Number(audio.attention_followup_interval_ms));
  const attentionMinFrames = Math.max(1, Math.ceil(Number(audio.attention_scan_min_audio_ms) / frameMs));
  const attentionMinRms = Number(audio.attention_scan_min_rms);
  const attentionSettleMs = Math.max(0, Number(audio.attention_command_settle_ms));
  const attentionMaxWaitMs = Math.max(attentionSettleMs, Number(audio.attention_command_max_wait_ms));
  const attentionDedupeMs = Math.max(0, Number(audio.attention_direct_dedupe_ms));
  const attentionHistoryLimit = Math.max(1, Number(audio.attention_history_limit));
  const attentionMaxPending = Math.max(1, Number(audio.attention_max_pending_scans));

  const whisper = createLiveWhisperService({ audio_config: audio });
  let piper;
  const state = {
    service_state: 'stopped',
    awake: options.initial_awake !== false,
    speaking: false,
    microphone_open: false,
    vad_ready: false,
    whisper_ready: false,
    whisper_backend: 'unavailable',
    piper_ready: false,
    playback_ready: false,
    last_error: null,
    last_heartbeat_at: null,
    last_audio_frame_at: null,
    last_speech_started_at: null,
    last_speech_ended_at: null,
    last_transcription_at: null,
    last_transcription_text: '',
    last_wake_gate_decision_at: null,
    last_wake_gate_reason: null,
    last_wake_gate_error: null,
    last_direct_address_at: null,
    last_reply_spoken_at: null,
    last_ambient_event_at: null,
    last_ambient_sink_error: null,
    last_attention_scan_at: null,
    last_attention_scan_text: '',
    last_attention_scan_error: null,
    last_attention_route_at: null,
    last_attention_route_text: '',
    attention_scans_completed: 0,
    attention_direct_routes: 0,
    attention_scan_history: [],
    attention_candidate_text: '',
    attention_candidate_started_at: null,
    attention_candidate_last_changed_at: null,
    direct_route_in_flight: false,
    utterances_completed: 0,
    ambient_events_recorded: 0,
    dropped_frames_while_gated: 0,
    session_id: options.session_id || newId('audiosession')
  };

  let componentsStarted = false;
  let recorder = null;
  let recorderExpectedStop = false;
  let vad = null;
  let stopping = false;
  let pcmBuffer = Buffer.alloc(0);
  let preRoll = [];
  let utterance = [];
  let speechActive = false;
  let startCount = 0;
  let endCount = 0;
  let postRemaining = 0;
  let ambientBuffer = [];
  let ambientActive = false;
  let ambientStartCount = 0;
  let ambientEndCount = 0;
  let ambientPeakRms = 0;
  let sequence = 0;
  let vadLineBuffer = '';
  const highPriorityAudioTasks = [];
  const normalPriorityAudioTasks = [];
  let audioTaskRunning = false;
  let audioIdleResolvers = [];
  let attentionFrames = [];
  let attentionLastQueuedAt = 0;
  let attentionPendingScans = 0;
  let attentionCandidate = null;
  let attentionCandidateTimer = null;
  let lastDirectRouteKey = '';
  let lastDirectRouteAt = 0;
  const pendingVadFrames = new Map();

  function refreshComponentState() {
    const whisperStatus = whisper.status();
    const piperStatus = piper ? piper.status() : { ready: false, playback_ready: false };
    state.whisper_ready = whisperStatus.ready === true;
    state.whisper_backend = whisperStatus.backend || 'unavailable';
    state.piper_ready = piperStatus.ready === true;
    state.playback_ready = piperStatus.playback_ready === true;
  }

  function snapshot(extra = {}) {
    refreshComponentState();
    return Object.freeze({
      ok: !state.last_error,
      marker: 'FLOKI_V2_LIVE_AUDIO_STATUS',
      ...state,
      process_pid: process.pid,
      recorder_pid: recorder && recorder.pid || null,
      vad_pid: vad && vad.pid || null,
      frame_ms: frameMs,
      pre_roll_ms: preRollFrames * frameMs,
      post_roll_ms: postRollFrames * frameMs,
      whisper: whisper.status(),
      piper: piper ? piper.status() : null,
      ...extra
    });
  }

  function publish(extra = {}) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    state.last_heartbeat_at = nowIso();
    const data = snapshot(extra);
    fs.writeFileSync(statusFile, JSON.stringify(data, null, 2) + '\n');
    fs.writeFileSync(heartbeatFile, JSON.stringify({ pid: process.pid, created_at: state.last_heartbeat_at, service_state: state.service_state }, null, 2) + '\n');
    if (typeof options.on_status === 'function') options.on_status(data);
    return data;
  }

  function appendAmbient(record) {
    const complete = Object.freeze({
      ...record,
      session_id: state.session_id,
      sequence: ++sequence,
      processed_at: record.processed_at || nowIso(),
      provenance: record.provenance || 'live_microphone'
    });
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, JSON.stringify(complete) + '\n');
    state.ambient_events_recorded += 1;
    state.last_ambient_event_at = complete.processed_at;
    if (typeof options.on_ambient_observation === 'function') {
      Promise.resolve(options.on_ambient_observation(complete)).then(() => {
        state.last_ambient_sink_error = null;
      }).catch((error) => {
        state.last_ambient_sink_error = 'ambient observation sink: ' + error.message;
        publish();
      });
    }
    return complete;
  }

  function resetSegmentation() {
    preRoll = [];
    utterance = [];
    speechActive = false;
    startCount = 0;
    endCount = 0;
    postRemaining = 0;
    ambientBuffer = [];
    ambientActive = false;
    ambientStartCount = 0;
    ambientEndCount = 0;
    ambientPeakRms = 0;
    attentionFrames = [];
    cancelAttentionCandidate();
    pendingVadFrames.clear();
  }

  function resolveAudioIdle() {
    if (audioTaskRunning || highPriorityAudioTasks.length || normalPriorityAudioTasks.length) return;
    const resolvers = audioIdleResolvers;
    audioIdleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function pumpAudioTasks() {
    if (audioTaskRunning) return;
    const entry = highPriorityAudioTasks.shift() || normalPriorityAudioTasks.shift();
    if (!entry) { resolveAudioIdle(); return; }
    audioTaskRunning = true;
    try {
      const value = await entry.task();
      entry.resolve(value);
    } catch (error) {
      state.last_error = error.message;
      publish();
      entry.reject(error);
    } finally {
      audioTaskRunning = false;
      setImmediate(pumpAudioTasks);
    }
  }

  function queueAudioProcessing(task, priority = 'normal') {
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (priority === 'high') highPriorityAudioTasks.push(entry);
      else normalPriorityAudioTasks.push(entry);
      pumpAudioTasks();
    });
  }

  function waitForAudioIdle(timeoutMs) {
    if (!audioTaskRunning && highPriorityAudioTasks.length === 0 && normalPriorityAudioTasks.length === 0) {
      return Promise.resolve();
    }
    return Promise.race([
      new Promise((resolve) => audioIdleResolvers.push(resolve)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  function classifyAmbientResult(parsed, metadata) {
    const records = [];
    for (const label of parsed.ambient_labels || []) {
      records.push({
        id: newId('audioevent'),
        type: 'ambient_sound',
        label,
        source_type: 'live_environment_sound',
        addressed_to_floki: false,
        captured_at: metadata.ended_at,
        confidence: 0.65,
        duration_ms: metadata.duration_ms,
        peak_rms: metadata.peak_rms,
        raw_model_output: parsed.raw_text
      });
    }
    if (parsed.speech_text) {
      const wake = classifyLiveHeardText(parsed.speech_text, state.speaking);
      if (!shouldRouteToCognition(wake)) {
        records.push({
          id: newId('audioevent'),
          type: 'ambient_speech',
          text: parsed.speech_text,
          source_type: 'ambient_conversation_or_media_unknown',
          addressed_to_floki: false,
          captured_at: metadata.ended_at,
          confidence: 0.72,
          duration_ms: metadata.duration_ms,
          raw_model_output: parsed.raw_text
        });
      }
    }
    if (records.length === 0) {
      records.push({
        id: newId('audioevent'),
        type: 'ambient_sound_unclassified',
        label: 'unclassified environmental sound',
        source_type: 'live_environment_sound',
        addressed_to_floki: false,
        captured_at: metadata.ended_at,
        confidence: 0.35,
        duration_ms: metadata.duration_ms,
        peak_rms: metadata.peak_rms,
        raw_model_output: parsed.raw_text
      });
    }
    return records;
  }

  function directRouteKey(classification) {
    return String(classification && classification.request_text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function recordAttentionScan(text, routeReason) {
    const entry = Object.freeze({ observed_at: nowIso(), text: String(text || ''), route_reason: routeReason || null });
    const history = state.attention_scan_history.concat([entry]).slice(-attentionHistoryLimit);
    state.attention_scan_history = history;
  }

  function cancelAttentionCandidate() {
    attentionCandidate = null;
    state.attention_candidate_text = '';
    state.attention_candidate_started_at = null;
    state.attention_candidate_last_changed_at = null;
    if (attentionCandidateTimer) clearTimeout(attentionCandidateTimer);
    attentionCandidateTimer = null;
  }

  async function routeDirectSpeech({ heard, classification, utteranceId, startedAt, endedAt, source }) {
    const key = directRouteKey(classification);
    const now = Date.now();
    if (key && key === lastDirectRouteKey && now - lastDirectRouteAt < attentionDedupeMs) {
      return Object.freeze({ duplicate: true, reply: '' });
    }
    if (source !== 'rolling_attention_scan') cancelAttentionCandidate();
    lastDirectRouteKey = key;
    lastDirectRouteAt = now;
    state.last_direct_address_at = nowIso();
    state.service_state = 'thinking';
    state.direct_route_in_flight = true;
    if (source === 'rolling_attention_scan') {
      state.last_attention_route_at = state.last_direct_address_at;
      state.last_attention_route_text = heard;
      state.attention_direct_routes += 1;
    }
    publish({ current_utterance_id: utteranceId, heard_text: heard, direct_address_source: source });
    try {
      const response = await options.on_direct_speech({
        utterance_id: utteranceId,
        raw_text: heard,
        request_text: classification.request_text,
        attention_only: classification.attention_only === true,
        speech_started_at: startedAt,
        speech_ended_at: endedAt,
        transcribed_at: state.last_transcription_at,
        received_by_brain_at: nowIso(),
        session_id: state.session_id,
        sequence: state.utterances_completed,
        source
      });
      if (response && response.reply) {
        await piper.speak(response.reply, { utterance_id: utteranceId, text_hash: 'live_audio_' + String(response.reply.length) });
        state.last_reply_spoken_at = nowIso();
      }
      return response || Object.freeze({ reply: '' });
    } catch (error) {
      state.last_error = 'direct speech route failed: ' + error.message;
      state.service_state = 'degraded';
      publish({ current_utterance_id: utteranceId });
      throw error;
    } finally {
      state.direct_route_in_flight = false;
      if (!state.speaking) {
        state.service_state = state.last_error ? 'degraded' : (state.awake ? 'listening' : 'sleeping');
      }
      publish({ current_utterance_id: null });
    }
  }

  function flushAttentionCandidate() {
    if (!attentionCandidate) return;
    const now = Date.now();
    const candidate = attentionCandidate;
    const hasCommand = candidate.classification.attention_only !== true && Boolean(directRouteKey(candidate.classification));
    const elapsedSinceChange = now - candidate.last_changed_at;
    const elapsedTotal = now - candidate.first_seen_at;
    const requiredWait = hasCommand ? attentionSettleMs : attentionMaxWaitMs;
    const elapsed = hasCommand ? elapsedSinceChange : elapsedTotal;

    if (elapsed < requiredWait) {
      if (attentionCandidateTimer) clearTimeout(attentionCandidateTimer);
      attentionCandidateTimer = setTimeout(flushAttentionCandidate, Math.max(1, requiredWait - elapsed));
      return;
    }

    cancelAttentionCandidate();
    if (!state.awake || state.speaking || stopping) return;
    void routeDirectSpeech({
      heard: candidate.heard,
      classification: candidate.classification,
      utteranceId: candidate.utterance_id,
      startedAt: candidate.started_at,
      endedAt: candidate.ended_at,
      source: 'rolling_attention_scan'
    }).catch(() => {});
  }

  function considerAttentionCandidate(heard, classification, metadata) {
    const now = Date.now();
    const key = directRouteKey(classification);
    const currentKey = attentionCandidate ? directRouteKey(attentionCandidate.classification) : '';
    const currentRequest = attentionCandidate ? String(attentionCandidate.classification.request_text || '') : '';
    const incomingRequest = String(classification.request_text || '');
    const shouldReplace = !attentionCandidate ||
      (attentionCandidate.classification.attention_only === true && classification.attention_only !== true) ||
      incomingRequest.length >= currentRequest.length;

    if (!attentionCandidate) {
      attentionCandidate = {
        heard,
        classification,
        key,
        first_seen_at: now,
        last_seen_at: now,
        last_changed_at: now,
        utterance_id: metadata.utterance_id,
        started_at: metadata.started_at,
        ended_at: metadata.ended_at
      };
    } else {
      const changed = key !== currentKey || heard !== attentionCandidate.heard;
      if (shouldReplace) {
        attentionCandidate.heard = heard;
        attentionCandidate.classification = classification;
        attentionCandidate.key = key;
        attentionCandidate.utterance_id = metadata.utterance_id;
        attentionCandidate.ended_at = metadata.ended_at;
      }
      attentionCandidate.last_seen_at = now;
      if (changed && shouldReplace) attentionCandidate.last_changed_at = now;
    }

    state.attention_candidate_text = attentionCandidate.heard;
    state.attention_candidate_started_at = new Date(attentionCandidate.first_seen_at).toISOString();
    state.attention_candidate_last_changed_at = new Date(attentionCandidate.last_changed_at).toISOString();

    if (attentionCandidateTimer) clearTimeout(attentionCandidateTimer);
    const hasCommand = attentionCandidate.classification.attention_only !== true && Boolean(directRouteKey(attentionCandidate.classification));
    const delay = hasCommand ? attentionSettleMs : Math.max(1, attentionMaxWaitMs - (now - attentionCandidate.first_seen_at));
    attentionCandidateTimer = setTimeout(flushAttentionCandidate, Math.max(1, delay));
    publish();
  }

  function scheduleAttentionScan() {
    if (!attentionScanEnabled || stopping || !state.awake || state.speaking) return;
    const now = Date.now();
    if (attentionFrames.length < attentionMinFrames) return;
    const scanIntervalMs = attentionCandidate ? attentionFollowupIntervalMs : attentionIntervalMs;
    if (now - attentionLastQueuedAt < scanIntervalMs) return;
    if (attentionPendingScans >= attentionMaxPending) return;
    const snapshotFrames = attentionFrames.slice(-attentionWindowFrames);
    const peakRms = snapshotFrames.reduce((peak, item) => Math.max(peak, item.rms), 0);
    if (peakRms < attentionMinRms) return;
    attentionLastQueuedAt = now;
    attentionPendingScans += 1;
    const scanId = newId('attentionscan');
    const endedAt = nowIso();
    queueAudioProcessing(async () => {
      const wavFile = path.join(tempDir, scanId + '.wav');
      try {
        if (!state.awake || state.speaking || stopping) return;
        writeWavPcm16(wavFile, Buffer.concat(snapshotFrames.map((entry) => entry.frame)), sampleRate, channels);
        const parsed = await whisper.transcribe(wavFile);
        const heard = String(parsed.speech_text || '').trim();
        state.last_attention_scan_at = nowIso();
        state.last_attention_scan_text = heard || parsed.raw_text || '';
        state.last_attention_scan_error = null;
        state.attention_scans_completed += 1;
        if (!heard) { recordAttentionScan('', 'no_speech_text'); return; }
        const classification = classifyLiveHeardText(heard, state.speaking);
        recordAttentionScan(heard, classification.reason || null);
        if (shouldRouteToCognition(classification)) {
          considerAttentionCandidate(heard, classification, {
            utterance_id: scanId,
            started_at: endedAt,
            ended_at: endedAt
          });
        }
      } catch (error) {
        state.last_attention_scan_at = nowIso();
        state.last_attention_scan_error = error.message;
        recordAttentionScan('', 'scan_error');
      } finally {
        attentionPendingScans = Math.max(0, attentionPendingScans - 1);
        fs.rmSync(wavFile, { force: true });
        publish();
      }
    }, 'high').catch(() => {});
  }

  function handleAttentionFrame(frame) {
    if (!attentionScanEnabled || stopping || !state.awake || state.speaking) return;
    attentionFrames.push({ frame, rms: pcmRms(frame) });
    if (attentionFrames.length > attentionWindowFrames) attentionFrames.shift();
    scheduleAttentionScan();
  }

  function finalizeAmbient(reason) {
    if (!ambientActive || ambientBuffer.length < minAmbientFrames) {
      ambientBuffer = [];
      ambientActive = false;
      ambientStartCount = 0;
      ambientEndCount = 0;
      ambientPeakRms = 0;
      return;
    }
    const frames = ambientBuffer.slice();
    const peak = ambientPeakRms;
    ambientBuffer = [];
    ambientActive = false;
    ambientStartCount = 0;
    ambientEndCount = 0;
    ambientPeakRms = 0;
    const endedAt = nowIso();
    const eventId = newId('ambientclip');
    queueAudioProcessing(async () => {
      if (!state.awake || state.speaking || stopping) return;
      const wavFile = path.join(tempDir, eventId + '.wav');
      try {
        writeWavPcm16(wavFile, Buffer.concat(frames), sampleRate, channels);
        const parsed = await whisper.transcribe(wavFile);
        for (const record of classifyAmbientResult(parsed, {
          ended_at: endedAt,
          duration_ms: Math.round(frames.length * frameMs),
          peak_rms: peak,
          reason
        })) appendAmbient(record);
      } finally {
        fs.rmSync(wavFile, { force: true });
        publish();
      }
    }, 'normal').catch(() => {});
  }

  function finalizeSpeech(reason) {
    if (!speechActive || utterance.length === 0) return;
    const frames = utterance.slice();
    const utteranceId = newId('utterance');
    const startedAt = state.last_speech_started_at || nowIso();
    const endedAt = nowIso();
    state.last_speech_ended_at = endedAt;
    state.service_state = 'transcribing';
    utterance = [];
    speechActive = false;
    startCount = 0;
    endCount = 0;
    postRemaining = 0;
    publish({ current_utterance_id: utteranceId, endpoint_reason: reason });

    queueAudioProcessing(async () => {
      const wavFile = path.join(tempDir, utteranceId + '.wav');
      let directRouteStarted = false;
      try {
        if (!state.awake || state.speaking || stopping) return;
        writeWavPcm16(wavFile, Buffer.concat(frames), sampleRate, channels);
        const parsed = await whisper.transcribe(wavFile);
        state.last_transcription_at = nowIso();
        state.last_transcription_text = parsed.speech_text || parsed.raw_text;
        state.utterances_completed += 1;

        for (const label of parsed.ambient_labels || []) appendAmbient({
          id: newId('audioevent'),
          type: 'ambient_sound',
          label,
          source_type: 'live_environment_sound',
          addressed_to_floki: false,
          captured_at: endedAt,
          utterance_id: utteranceId,
          confidence: 0.65,
          raw_model_output: parsed.raw_text
        });

        const heard = String(parsed.speech_text || '').trim();
        if (!heard) return;
        let classification;
        try {
          classification = classifyLiveHeardText(heard, state.speaking);
          state.last_wake_gate_decision_at = nowIso();
          state.last_wake_gate_reason = classification.reason || null;
          state.last_wake_gate_error = null;
          if (state.last_error && state.last_error.startsWith('wake gate classification failed:')) {
            state.last_error = null;
          }
        } catch (error) {
          state.last_wake_gate_decision_at = nowIso();
          state.last_wake_gate_reason = 'classification_error';
          state.last_wake_gate_error = error.message;
          state.last_error = 'wake gate classification failed: ' + error.message;
          state.service_state = 'degraded';
          publish({ current_utterance_id: utteranceId, heard_text: heard });
          return;
        }
        if (!shouldRouteToCognition(classification)) {
          appendAmbient({
            id: newId('audioevent'),
            type: 'ambient_speech',
            text: heard,
            source_type: 'ambient_conversation_or_media_unknown',
            addressed_to_floki: false,
            captured_at: endedAt,
            utterance_id: utteranceId,
            confidence: 0.78,
            raw_model_output: parsed.raw_text
          });
          return;
        }

        directRouteStarted = true;
        void routeDirectSpeech({
          heard,
          classification,
          utteranceId,
          startedAt,
          endedAt,
          source: 'vad_finalized_utterance'
        }).catch(() => {});
      } finally {
        fs.rmSync(wavFile, { force: true });
        if (!directRouteStarted) {
          state.service_state = state.last_wake_gate_error
            ? 'degraded'
            : (state.awake ? 'listening' : 'sleeping');
          publish({ current_utterance_id: null });
        }
      }
    }, 'high').catch(() => {});
  }

  function handleVadProbability(frame, probability) {
    if (stopping || !state.awake || state.speaking) {
      state.dropped_frames_while_gated += 1;
      return;
    }
    const rms = pcmRms(frame);
    preRoll.push(frame);
    if (preRoll.length > preRollFrames) preRoll.shift();

    if (speechActive) {
      utterance.push(frame);
      if (utterance.length >= maxUtteranceFrames) { finalizeSpeech('max_duration'); return; }
      if (postRemaining > 0) {
        postRemaining -= 1;
        if (postRemaining === 0) finalizeSpeech('vad_endpoint');
        return;
      }
      endCount = probability < endThreshold ? endCount + 1 : 0;
      if (endCount >= endFrames) postRemaining = postRollFrames || 1;
      return;
    }

    startCount = probability >= startThreshold ? startCount + 1 : 0;
    if (startCount >= startFrames) {
      ambientBuffer = [];
      ambientActive = false;
      ambientStartCount = 0;
      ambientEndCount = 0;
      ambientPeakRms = 0;
      speechActive = true;
      utterance = preRoll.slice();
      state.last_speech_started_at = nowIso();
      state.service_state = 'speech_detected';
      publish();
      return;
    }

    if (probability >= endThreshold) return;
    if (!ambientActive) {
      ambientStartCount = rms >= ambientStartRms ? ambientStartCount + 1 : 0;
      if (ambientStartCount >= ambientStartFrames) {
        ambientActive = true;
        ambientBuffer = preRoll.slice(-Math.min(preRoll.length, Math.max(1, Math.ceil(300 / frameMs))));
        ambientPeakRms = rms;
      }
      return;
    }

    ambientBuffer.push(frame);
    ambientPeakRms = Math.max(ambientPeakRms, rms);
    ambientEndCount = rms <= ambientEndRms ? ambientEndCount + 1 : 0;
    if (ambientBuffer.length >= maxAmbientFrames) finalizeAmbient('max_duration');
    else if (ambientEndCount >= ambientEndFrames) finalizeAmbient('energy_endpoint');
  }

  function startVadWorker() {
    if (vad && vad.pid) return;
    vad = spawn(PYTHON, [VAD_WORKER], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', FLOKI_VAD_SAMPLE_RATE: String(sampleRate) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    vad.stdin.on('error', (error) => {
      if (!stopping && error.code !== 'EPIPE') { state.last_error = 'VAD stdin: ' + error.message; publish(); }
    });
    vad.stdout.on('data', (chunk) => {
      vadLineBuffer += String(chunk || '');
      let newline;
      while ((newline = vadLineBuffer.indexOf('\n')) >= 0) {
        const line = vadLineBuffer.slice(0, newline).trim();
        vadLineBuffer = vadLineBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') {
            state.vad_ready = true;
            if (state.awake && !state.speaking && !stopping) startRecorder();
            publish();
          }
          else if (message.type === 'probability') {
            const frame = pendingVadFrames.get(Number(message.sequence));
            pendingVadFrames.delete(Number(message.sequence));
            if (frame) handleVadProbability(frame, Number(message.probability || 0));
          } else if (message.type === 'error') {
            state.last_error = 'Silero VAD: ' + message.error;
            publish();
          }
        } catch (error) {
          state.last_error = 'VAD output parse: ' + error.message;
          publish();
        }
      }
    });
    vad.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message) { state.last_error = 'Silero VAD worker: ' + message.slice(-500); publish(); }
    });
    vad.once('close', (code, signal) => {
      state.vad_ready = false;
      if (!stopping) { state.last_error = 'Silero VAD worker exited (' + String(code) + '/' + String(signal || '') + ')'; publish(); }
    });
  }

  function sendFrameToVad(frame) {
    if (!vad || !vad.stdin || vad.stdin.destroyed || vad.stdin.writableEnded || !state.vad_ready) return;
    const id = ++sequence;
    pendingVadFrames.set(id, frame);
    if (pendingVadFrames.size > 200) pendingVadFrames.delete(pendingVadFrames.keys().next().value);
    vad.stdin.write(JSON.stringify({ sequence: id, pcm16_base64: frame.toString('base64') }) + '\n', (error) => {
      if (error && error.code !== 'EPIPE') { state.last_error = 'VAD write: ' + error.message; publish(); }
    });
  }

  function startRecorder() {
    if (recorder || stopping || !state.awake || state.speaking || !state.vad_ready) return;
    recorderExpectedStop = false;
    recorder = spawn(arecord, ['-q', '-D', String(audio.mic_device || 'default'), '-t', 'raw', '-f', String(audio.mic_format || 'S16_LE'), '-r', String(sampleRate), '-c', String(channels)], { stdio: ['ignore', 'pipe', 'pipe'] });
    recorder.stdout.on('data', (chunk) => {
      state.last_audio_frame_at = nowIso();
      pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
      while (pcmBuffer.length >= frameBytes) {
        const frame = Buffer.from(pcmBuffer.subarray(0, frameBytes));
        pcmBuffer = pcmBuffer.subarray(frameBytes);
        if (!state.awake || state.speaking) { state.dropped_frames_while_gated += 1; continue; }
        handleAttentionFrame(frame);
        sendFrameToVad(frame);
      }
    });
    recorder.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message && !/overrun/i.test(message) && !recorderExpectedStop) { state.last_error = 'arecord: ' + message.slice(-500); publish(); }
    });
    recorder.once('error', (error) => {
      state.microphone_open = false;
      recorder = null;
      if (!recorderExpectedStop) { state.last_error = 'arecord start failed: ' + error.message; publish(); }
    });
    recorder.once('close', (code, signal) => {
      state.microphone_open = false;
      recorder = null;
      pcmBuffer = Buffer.alloc(0);
      if (!stopping && !recorderExpectedStop && state.awake && !state.speaking) {
        state.last_error = 'arecord exited (' + String(code) + '/' + String(signal || '') + ')';
        publish();
      }
    });
    state.microphone_open = true;
    publish();
  }

  async function stopRecorder() {
    if (!recorder) { state.microphone_open = false; return; }
    const child = recorder;
    recorderExpectedStop = true;
    state.microphone_open = false;
    resetSegmentation();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    if (recorder === child) recorder = null;
    pcmBuffer = Buffer.alloc(0);
  }

  piper = createLivePiperService({
    audio_config: audio,
    output_dir: tempDir,
    async on_speaking_change(speaking) {
      state.speaking = speaking === true;
      if (state.speaking) {
        state.service_state = 'speaking';
        await stopRecorder();
      } else {
        state.service_state = state.awake ? 'listening' : 'sleeping';
        if (state.awake && !stopping) startRecorder();
      }
      publish();
    }
  });

  async function ensureAwakeServices() {
    if (!state.awake || stopping) return snapshot();
    if (!arecord) throw new Error('arecord command not found');
    if (!fileExecutable(PYTHON)) throw new Error('Silero Python venv is not executable: ' + PYTHON);
    if (!fs.existsSync(VAD_WORKER)) throw new Error('Silero VAD worker missing: ' + VAD_WORKER);

    if (!whisper.status().ready) await whisper.start();
    piper.refreshReadiness();
    if (!piper.status().ready) {
      throw new Error('Piper/playback is not ready: ' + JSON.stringify(piper.status()));
    }

    startVadWorker();
    componentsStarted = true;
    state.last_error = null;
    if (state.vad_ready) startRecorder();
    return snapshot();
  }

  async function start() {
    if (state.service_state !== 'stopped') return snapshot();
    fs.mkdirSync(tempDir, { recursive: true });
    stopping = false;
    state.last_error = null;

    if (!state.awake) {
      state.service_state = 'sleeping';
      publish();
      return snapshot();
    }

    state.service_state = 'starting';
    publish();
    await ensureAwakeServices();
    state.service_state = 'listening';
    publish();
    return snapshot();
  }

  async function stop() {
    stopping = true;
    state.service_state = 'stopping';
    publish();
    await stopRecorder();
    if (vad && vad.stdin && !vad.stdin.destroyed && !vad.stdin.writableEnded) {
      try { vad.stdin.write(JSON.stringify({ command: 'stop' }) + '\n'); } catch (_error) { /* ignore */ }
    }
    if (vad && vad.pid) vad.kill('SIGTERM');
    vad = null;
    componentsStarted = false;
    await whisper.stop();
    await waitForAudioIdle(3000);
    fs.rmSync(tempDir, { recursive: true, force: true });
    state.microphone_open = false;
    state.vad_ready = false;
    state.service_state = 'stopped';
    publish();
    return snapshot();
  }

  async function setAwake(awake) {
    const next = awake === true;
    const changed = state.awake !== next;
    state.awake = next;
    if (changed) resetSegmentation();

    if (!next) {
      state.service_state = 'sleeping';
      await stopRecorder();
      state.last_error = null;
      publish();
      return snapshot();
    }

    if (state.speaking || stopping) {
      state.service_state = state.speaking ? 'speaking' : 'stopping';
      publish();
      return snapshot();
    }

    try {
      state.service_state = componentsStarted ? 'listening' : 'starting';
      publish();
      await ensureAwakeServices();
      state.service_state = 'listening';
      if (state.vad_ready) startRecorder();
      publish();
      return snapshot();
    } catch (error) {
      state.last_error = error.message;
      state.service_state = 'degraded';
      publish();
      throw error;
    }
  }

  return Object.freeze({
    start,
    stop,
    setAwake,
    speak: (text, metadata) => piper.speak(text, metadata),
    status: () => snapshot(),
    publish,
    paths: Object.freeze({ runtime_dir: runtimeDir, status_file: statusFile, heartbeat_file: heartbeatFile, events_file: eventsFile })
  });
}

module.exports = {
  ROOT,
  PYTHON,
  VAD_WORKER,
  WHISPER_CLI,
  WHISPER_MODEL_DIR,
  commandPath,
  fileExecutable,
  whisperModelPath,
  writeWavPcm16,
  pcmRms,
  parseWhisperResult: parseWhisperText,
  classifyLiveHeardText,
  createLiveAudioService
};
