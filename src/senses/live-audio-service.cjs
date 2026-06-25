'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT, getAudioConfig, getPathConfig, getTimeoutConfig } = require('../config/floki-config.cjs');
const { classifyWakeInput, shouldRouteToCognition } = require('../chat/wake-word-gate.cjs');
const { createLiveWhisperService, parseWhisperText, whisperModelPath, WHISPER_CLI, WHISPER_MODEL_DIR } = require('./live-whisper-service.cjs');
const { createLivePiperService } = require('./live-piper-service.cjs');
const { createVoiceOutputLock } = require('../chat/voice-output-lock.cjs');
const { createWakeCommandContinuation } = require('../chat/wake-command-continuation.cjs');
const { getInterfaceSettings } = require('../config/interface-settings.cjs');
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
  const interfaceSettings = options.interface_settings || getInterfaceSettings('chat');
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(ROOT, paths.chat_runtime_root);
  const tempDir = path.join(runtimeDir, 'audio-tmp');
  const statusFile = path.join(runtimeDir, 'live-audio.status.json');
  const heartbeatFile = path.join(runtimeDir, 'live-audio.heartbeat.json');
  const eventsFile = path.join(runtimeDir, 'ambient-audio-events.jsonl');
  const arecord = options.arecord_command || commandPath('arecord');

  const sampleRate = Number(audio.mic_rate);
  const channels = Number(audio.mic_channels);
  const frameSamples = Number(audio.vad_frame_samples);
  const frameBytes = frameSamples * channels * 2;
  const frameMs = frameSamples / sampleRate * 1000;
  const preRollFrames = Math.max(1, Math.ceil(Number(audio.pre_roll_ms) / frameMs));
  const postRollFrames = Math.max(0, Math.ceil(Number(audio.post_roll_ms) / frameMs));
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
  const rollingBufferFrames = Math.max(1, Math.ceil(Number(audio.rolling_buffer_seconds || 30) * 1000 / frameMs));
  const vadEndpointSilenceFrames = Math.max(1, Math.ceil(Number(audio.vad_endpoint_silence_ms || 800) / frameMs));
  const vadMinSpeechFrames = Math.max(1, Math.ceil(Number(audio.vad_min_speech_ms || 250) / frameMs));
  const vadMaxSpeechFrames = Math.max(1, Math.ceil(Number(audio.vad_max_speech_seconds || 30) * 1000 / frameMs));
  const hearingDuplicateWindowMs = Math.max(0, Number(audio.hearing_duplicate_window_ms || 2000));
  const recorderRestartDelayMs = Math.max(100, Math.ceil(Number(audio.live_loop_restart_seconds || 0.1) * 1000));
  const maxRecorderRestarts = Math.max(1, Number(audio.recorder_max_restarts || 5));
  const microphoneReadinessTimeoutMs = Number(audio.microphone_readiness_timeout_ms);
  const microphoneReadinessPollMs = Number(audio.microphone_readiness_poll_ms);
  const recorderStopTimeoutMs = Number(audio.recorder_stop_timeout_ms);
  const recorderRestartBackoffMaxMs = Number(audio.recorder_restart_backoff_max_ms);
  const wakeCommandContinuationMs = Number(audio.wake_command_continuation_ms);
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

  const whisper = (options.deps && options.deps.whisper) ? options.deps.whisper : createLiveWhisperService({ audio_config: audio });
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
    recorder_consecutive_failures: 0,
    recorder_restarts_attempted: 0,
    recorder_restarts_exhausted: false,
    current_utterance_id: null,
    wake_phrase_detected_in_current_utterance: false,
    pending_wake_command: false,
    pending_wake_phrase: '',
    pending_wake_since_at: null,
    pending_wake_expires_at: null,
    wake_command_continuation_ms: wakeCommandContinuationMs,
    last_dispatched_request_key: '',
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
  let currentUtteranceId = null;
  let pendingTranscriptId = null;
  let wakePhraseDetectedInCurrentUtterance = false;
  let lastDispatchedRequestKey = '';
  let lastDispatchedAt = 0;
  let recorderConsecutiveFailures = 0;
  let recorderRestartInFlight = false;
  let recorderRestartTimer = null;
  let microphoneReadyPromise = null;
  const voiceLock = createVoiceOutputLock({ lock_file: options.voice_lock_file });
  const wakeContinuation = createWakeCommandContinuation({ continuation_ms: wakeCommandContinuationMs, wake_gate_config: options.wake_gate_config });

  function syncWakeContinuationStatus(nowMs = Date.now()) {
    const wake = wakeContinuation.status(nowMs);
    state.pending_wake_command = wake.pending;
    state.pending_wake_phrase = wake.pending_phrase;
    state.pending_wake_since_at = wake.pending_since_at;
    state.pending_wake_expires_at = wake.pending_expires_at;
    state.wake_phrase_detected_in_current_utterance = wake.partial_wake_detected || wakePhraseDetectedInCurrentUtterance;
    return wake;
  }

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
      rolling_buffer_frames: rollingBufferFrames,
      rolling_buffer_ms: rollingBufferFrames * frameMs,
      vad_endpoint_silence_frames: vadEndpointSilenceFrames,
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
    currentUtteranceId = null;
    pendingTranscriptId = null;
    wakePhraseDetectedInCurrentUtterance = false;
    wakeContinuation.clear();
    state.current_utterance_id = null;
    syncWakeContinuationStatus();
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

  async function routeDirectSpeech({ heard, classification, utteranceId, transcriptId, startedAt, endedAt, source }) {
    const key = directRouteKey(classification);
    const now = Date.now();
    if (key && key === lastDirectRouteKey && now - lastDirectRouteAt < attentionDedupeMs) {
      return Object.freeze({ duplicate: true, reply: '' });
    }
    if (key && key === lastDispatchedRequestKey && now - lastDispatchedAt < hearingDuplicateWindowMs) {
      return Object.freeze({ duplicate: true, reply: '' });
    }
    cancelAttentionCandidate();
    lastDirectRouteKey = key;
    lastDirectRouteAt = now;
    lastDispatchedRequestKey = key;
    lastDispatchedAt = now;
    state.last_dispatched_request_key = key;
    state.last_direct_address_at = nowIso();
    state.service_state = 'thinking';
    state.direct_route_in_flight = true;
    if (typeof options.on_cognition_start === 'function') options.on_cognition_start({ utterance_id: utteranceId, started_at: nowIso(), text: classification.request_text });
    if (source === 'rolling_attention_scan') {
      state.last_attention_route_at = state.last_direct_address_at;
      state.last_attention_route_text = heard;
      state.attention_direct_routes += 1;
    }
    publish({ current_utterance_id: utteranceId, heard_text: heard, direct_address_source: source });
    try {
      const response = await options.on_direct_speech({
        utterance_id: utteranceId,
        transcript_id: transcriptId || utteranceId,
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
      if (response && response.reply && interfaceSettings.voice.speakerEnabled === true) {
        if (typeof options.on_tts_start === 'function') options.on_tts_start({ utterance_id: utteranceId, started_at: nowIso(), text: response.reply });
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
    const candidate = attentionCandidate;
    cancelAttentionCandidate();
    if (!state.awake || state.speaking || stopping) return;
    const wake = wakeContinuation.observePartial({
      text: candidate.heard,
      speaking: state.speaking,
      speech_active: speechActive,
      now_ms: Date.now()
    });
    wakePhraseDetectedInCurrentUtterance = wake.partial_wake_detected === true;
    syncWakeContinuationStatus();
    publish();
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

    if (attentionCandidate.classification && attentionCandidate.classification.gate_open === true) {
      if (speechActive) {
        wakePhraseDetectedInCurrentUtterance = true;
        state.wake_phrase_detected_in_current_utterance = true;
      } else {
        pendingWakePhraseDetection = true;
      }
    }

    if (attentionCandidateTimer) clearTimeout(attentionCandidateTimer);
    const hasCommand = attentionCandidate.classification.attention_only !== true && Boolean(directRouteKey(attentionCandidate.classification));
    const delay = hasCommand ? attentionSettleMs : Math.max(1, attentionMaxWaitMs - (now - attentionCandidate.first_seen_at));
    attentionCandidateTimer = setTimeout(flushAttentionCandidate, Math.max(1, delay));
    publish();
  }

  function scheduleAttentionScan() {
    if (!attentionScanEnabled || stopping || !state.awake || state.speaking || voiceLock.isEarsMuted().ears_muted_now) return;
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
        if (interfaceSettings.voice.showPartialTranscription === true && classification.gate_open === true && typeof options.on_transcript === 'function') {
          const transcriptId = pendingTranscriptId || currentUtteranceId || scanId;
          options.on_transcript({ id: transcriptId, phase: 'partial', text: heard, transcribed_at: nowIso(), utterance_id: transcriptId, source: 'rolling_attention_scan' });
        }
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
    }, 'high').catch((error) => { state.last_error = 'high-priority audio task failed: ' + error.message; state.service_state = 'degraded'; publish(); });
  }

  function handleAttentionFrame(frame) {
    if (!attentionScanEnabled || stopping || !state.awake || state.speaking || voiceLock.isEarsMuted().ears_muted_now) return;
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
      if (!state.awake || state.speaking || stopping || voiceLock.isEarsMuted().ears_muted_now) return;
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
    }, 'normal').catch((error) => { state.last_error = 'ambient audio task failed: ' + error.message; state.service_state = 'degraded'; publish(); });
  }

  function finalizeSpeech(reason) {
    if (!speechActive || utterance.length === 0) return;
    const frames = utterance.slice();
    const utteranceId = currentUtteranceId || newId('utterance');
    const startedAt = state.last_speech_started_at || nowIso();
    const endedAt = nowIso();
    state.last_speech_ended_at = endedAt;
    state.service_state = 'transcribing';
    utterance = [];
    speechActive = false;
    startCount = 0;
    endCount = 0;
    postRemaining = 0;
    currentUtteranceId = null;
    const wakeDetectedDuringUtterance = wakePhraseDetectedInCurrentUtterance || wakeContinuation.status().partial_wake_detected;
    wakePhraseDetectedInCurrentUtterance = false;
    state.current_utterance_id = null;
    syncWakeContinuationStatus();
    publish({ current_utterance_id: utteranceId, endpoint_reason: reason });

    queueAudioProcessing(async () => {
      const wavFile = path.join(tempDir, utteranceId + '.wav');
      let directRouteStarted = false;
      try {
        if (!state.awake || state.speaking || stopping || voiceLock.isEarsMuted().ears_muted_now) return;
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
        let decision;
        try {
          decision = wakeContinuation.processFinalTranscript({
            text: heard,
            speaking: state.speaking,
            now_ms: Date.now(),
            utterance_id: utteranceId,
            wake_detected_during_utterance: wakeDetectedDuringUtterance
          });
          syncWakeContinuationStatus();
          const classification = decision.classification;
          state.last_wake_gate_decision_at = nowIso();
          state.last_wake_gate_reason = classification && classification.reason || decision.action;
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
          throw error;
        }

        if (decision.action === 'wait_for_command') {
          pendingTranscriptId = pendingTranscriptId || utteranceId;
          if (interfaceSettings.voice.showPartialTranscription === true && typeof options.on_transcript === 'function') options.on_transcript({ id: pendingTranscriptId, phase: 'partial', text: decision.raw_text, transcribed_at: state.last_transcription_at, utterance_id: utteranceId, source: decision.source });
          state.service_state = 'listening';
          publish({ current_utterance_id: null, heard_text: heard, wake_waiting_for_command: true });
          return;
        }

        if (decision.action !== 'route') {
          if (pendingTranscriptId && typeof options.on_transcript_discard === 'function') {
            options.on_transcript_discard({ id: pendingTranscriptId, utterance_id: utteranceId, reason: decision.action });
            pendingTranscriptId = null;
          }
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

        const transcriptId = pendingTranscriptId || utteranceId;
        if (typeof options.on_transcript === 'function') options.on_transcript({ id: transcriptId, phase: 'final', text: decision.raw_text, transcribed_at: state.last_transcription_at, utterance_id: utteranceId, source: decision.source });
        pendingTranscriptId = null;
        directRouteStarted = true;
        await routeDirectSpeech({
          heard: decision.raw_text,
          classification: decision.classification,
          utteranceId,
          transcriptId,
          startedAt,
          endedAt,
          source: decision.source
        });
      } finally {
        fs.rmSync(wavFile, { force: true });
        if (!directRouteStarted) {
          state.service_state = state.last_wake_gate_error
            ? 'degraded'
            : (state.awake ? 'listening' : 'sleeping');
          publish({ current_utterance_id: null });
        }
      }
    }, 'high').catch((error) => { state.last_error = 'high-priority audio task failed: ' + error.message; state.service_state = 'degraded'; publish(); });
  }

  function handleVadProbability(frame, probability) {
    if (!canOpenMicrophone()) {
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
      currentUtteranceId = newId('utterance');
      state.current_utterance_id = currentUtteranceId;
      wakePhraseDetectedInCurrentUtterance = wakeContinuation.status().partial_wake_detected === true;
      syncWakeContinuationStatus();
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

  function canOpenMicrophone() {
    if (stopping || !state.awake || state.speaking) return false;
    const ears = voiceLock.isEarsMuted();
    if (ears.ears_muted_now === true) return false;
    return true;
  }

  function startVadWorker() {
    if (vad && vad.pid) return;
    if (options.deps && options.deps.disable_vad_worker === true) {
      state.vad_ready = true;
      publish();
      return;
    }
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

  function attachRecorderHandlers(child) {
    child.stdout.on('data', (chunk) => {
      state.last_audio_frame_at = nowIso();
      recorderConsecutiveFailures = 0;
      state.recorder_consecutive_failures = 0;
      pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
      while (pcmBuffer.length >= frameBytes) {
        const frame = Buffer.from(pcmBuffer.subarray(0, frameBytes));
        pcmBuffer = pcmBuffer.subarray(frameBytes);
        if (!canOpenMicrophone()) { state.dropped_frames_while_gated += 1; continue; }
        handleAttentionFrame(frame);
        sendFrameToVad(frame);
      }
    });
    child.stderr.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (message && !/overrun/i.test(message) && !recorderExpectedStop) { state.last_error = 'arecord: ' + message.slice(-500); publish(); }
    });
    child.once('error', (error) => {
      state.microphone_open = false;
      recorder = null;
      if (!recorderExpectedStop) {
        state.last_error = 'arecord start failed: ' + error.message;
        recorderConsecutiveFailures += 1;
        state.recorder_consecutive_failures = recorderConsecutiveFailures;
        scheduleRecorderRestart();
        publish();
      }
    });
    child.once('close', (code, signal) => {
      state.microphone_open = false;
      recorder = null;
      pcmBuffer = Buffer.alloc(0);
      if (!stopping && !recorderExpectedStop && state.awake && !state.speaking) {
        recorderConsecutiveFailures += 1;
        state.recorder_consecutive_failures = recorderConsecutiveFailures;
        state.last_error = 'arecord exited (' + String(code) + '/' + String(signal || '') + ')';
        scheduleRecorderRestart();
        publish();
      }
    });
  }

  function startRecorder() {
    if (recorder || recorderRestartInFlight || stopping || !state.awake || !state.vad_ready) return false;
    if (!canOpenMicrophone()) return false;
    recorderExpectedStop = false;
    const recorderFactory = (options.deps && options.deps.recorder_factory) || options.recorder_factory;
    const spawnArecord = recorderFactory || (() => spawn(arecord, ['-q', '-D', String(audio.mic_device || 'default'), '-t', 'raw', '-f', String(audio.mic_format || 'S16_LE'), '-r', String(sampleRate), '-c', String(channels)], { stdio: ['ignore', 'pipe', 'pipe'] }));
    recorder = spawnArecord();
    attachRecorderHandlers(recorder);
    state.microphone_open = true;
    publish();
    return true;
  }

  function scheduleRecorderRestart() {
    if (recorderRestartInFlight || recorder || stopping || !state.awake || state.speaking) return;
    if (recorderConsecutiveFailures >= maxRecorderRestarts) {
      state.recorder_restarts_exhausted = true;
      state.service_state = 'degraded';
      state.last_error = 'arecord recovery exhausted after ' + String(recorderConsecutiveFailures) + ' attempts';
      publish();
      return;
    }
    recorderRestartInFlight = true;
    state.recorder_restarts_attempted += 1;
    const delay = Math.min(recorderRestartBackoffMaxMs, recorderRestartDelayMs * Math.pow(2, recorderConsecutiveFailures));
    if (recorderRestartTimer) clearTimeout(recorderRestartTimer);
    recorderRestartTimer = setTimeout(async () => {
      if (stopping || !state.awake || state.speaking || recorder) {
        recorderRestartInFlight = false;
        return;
      }
      const started = startRecorder();
      if (started) {
        const ready = await verifyMicrophoneReady();
        if (!ready) {
          state.last_error = 'arecord restarted but no PCM frames arrived';
          recorderConsecutiveFailures += 1;
          state.recorder_consecutive_failures = recorderConsecutiveFailures;
          if (recorder) {
            recorderExpectedStop = true;
            recorder.kill('SIGTERM');
            recorder = null;
          }
          recorderRestartInFlight = false;
          scheduleRecorderRestart();
          publish();
          return;
        }
      }
      recorderRestartInFlight = false;
      publish();
    }, delay);
  }

  async function verifyMicrophoneReady(openedAtMs = 0) {
    const deadline = Date.now() + microphoneReadinessTimeoutMs;
    while (Date.now() < deadline) {
      const frameAt = state.last_audio_frame_at ? new Date(state.last_audio_frame_at).getTime() : 0;
      if (Number.isFinite(frameAt) && frameAt >= openedAtMs) return true;
      await new Promise((resolve) => setTimeout(resolve, microphoneReadinessPollMs));
    }
    return false;
  }

  async function stopRecorder() {
    if (recorderRestartTimer) { clearTimeout(recorderRestartTimer); recorderRestartTimer = null; }
    if (!recorder) { state.microphone_open = false; return; }
    const child = recorder;
    recorderExpectedStop = true;
    state.microphone_open = false;
    resetSegmentation();
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, recorderStopTimeoutMs))
    ]);
    if (recorder === child) recorder = null;
    pcmBuffer = Buffer.alloc(0);
  }

  async function onSpeakingChange(speaking) {
    state.speaking = speaking === true;
    if (state.speaking) {
      state.service_state = 'speaking';
      wakeContinuation.clear();
      syncWakeContinuationStatus();
      await stopRecorder();
      if (typeof options.on_microphone_lifecycle === 'function') options.on_microphone_lifecycle({ phase: 'closed_for_tts', speaking: true, microphone_open: false, observed_at: nowIso() });
      publish();
      return;
    }

    state.service_state = state.awake ? 'listening' : 'sleeping';
    if (state.awake && !stopping && state.vad_ready) {
      const openedAt = Date.now();
      if (!startRecorder()) {
        throw new Error('microphone did not reopen after Piper playback');
      }
      const ready = await verifyMicrophoneReady(openedAt);
      if (typeof options.on_microphone_lifecycle === 'function') options.on_microphone_lifecycle({ phase: 'reopened_after_tts', speaking: false, microphone_open: state.microphone_open, fresh_pcm_received: ready, reopened_at: new Date(openedAt).toISOString(), observed_at: nowIso() });
      if (!ready) {
        state.last_error = 'microphone reopened after Piper playback but no fresh PCM frames arrived';
        state.service_state = 'degraded';
        scheduleRecorderRestart();
        publish();
        throw new Error(state.last_error);
      }
    }
    publish();
  }

  if (options.deps && options.deps.piper) {
    piper = options.deps.piper;
    if (typeof piper.setOnSpeakingChange === 'function') {
      piper.setOnSpeakingChange(onSpeakingChange);
    }
  } else {
    piper = createLivePiperService({
      audio_config: audio,
      output_dir: tempDir,
      on_speaking_change: onSpeakingChange
    });
  }

  async function ensureAwakeServices() {
    if (!state.awake || stopping) return snapshot();
    const recorderFactory = (options.deps && options.deps.recorder_factory) || options.recorder_factory;
    if (!recorderFactory && !arecord) throw new Error('arecord command not found');
    if (!options.deps?.disable_vad_worker && !fileExecutable(PYTHON)) throw new Error('Silero Python venv is not executable: ' + PYTHON);
    if (!options.deps?.disable_vad_worker && !fs.existsSync(VAD_WORKER)) throw new Error('Silero VAD worker missing: ' + VAD_WORKER);

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

  function injectVadProbability(frame, probability) {
    if (!frame || frame.length !== frameBytes) {
      throw new Error('injected VAD frame must be ' + String(frameBytes) + ' bytes');
    }
    if (stopping || !state.awake || state.speaking) return;
    handleVadProbability(Buffer.from(frame), Number(probability || 0));
  }

  function injectVoiceLock(speaking) {
    if (speaking === true) voiceLock.beginSpeaking({ source: 'test_inject', ttl_ms: 5000 });
    else voiceLock.endSpeaking({ reason: 'test_inject' });
  }

  return Object.freeze({
    start,
    stop,
    setAwake,
    speak: (text, metadata) => piper.speak(text, metadata),
    interruptSpeech: () => piper.interrupt(),
    status: () => snapshot(),
    publish,
    injectVadProbability,
    injectVoiceLock,
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
