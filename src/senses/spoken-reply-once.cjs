'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  runChatHearingLoopProof
} = require('./chat-hearing-loop-smoke.cjs');

const {
  runHearingToCognitionBridgeProof
} = require('./hearing-to-cognition-bridge.cjs');

const {
  runPlaybackWithVoiceLock,
  runPlaybackWithVoiceLockAsync
} = require('./piper-speaker-playback.cjs');

const { synthesizePiperSpeechToFileAsync } = require('./piper-speech-smoke.cjs');

const {
  recordWakeActivityIfSleeping
} = require('../chat/sleep-cycle.cjs');

const { appendChatTranscriptTurn, appendPrivateThoughtRecord, assertPublicTranscriptText } = require('../chat/chat-transcript.cjs');

const { PROJECT_ROOT: ROOT, getLiveChatConfig, getModelConfig, getPathConfig } = require('../config/floki-config.cjs');
const { createLatencyTrace } = require('../util/latency-trace.cjs');
const { readLatestPrivateObservation } = require('../vision/chat-webcam-vision-service.cjs');
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const SPOKEN_REPLY_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'spoken-reply-once');

function spokenReplyOnceAllowed(env = process.env) {
  return env.FLOKI_ALLOW_SPOKEN_REPLY_ONCE === '1';
}

function spokenReplyOnceGuardStatus(env = process.env) {
  const allowed = spokenReplyOnceAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_SPOKEN_REPLY_ONCE=1',
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    wake_gate_checked_now: false,
    qwen_cognition_run_now: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    piper_wav_created_now: false,
    speaker_playback_run_now: false,
    voice_output_lock_started: false,
    ears_muted_during_playback: false,
    voice_output_lock_cleared_after_playback: false,
    ears_open_after_playback: false,
    chat_mode_only: true,
    reason: allowed
      ? 'One-shot spoken reply is explicitly allowed for this one proof run.'
      : 'One-shot spoken reply is guarded. Use npm run proof:spoken-reply-once when ready to record, think, synthesize, and speak once.'
  });
}

function writeSpokenReplyReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const outputDir = options.output_dir || SPOKEN_REPLY_OUTPUT_DIR;
  const reportFile = options.report_file || path.join(outputDir, 'latest-spoken-reply-once.json');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');

  return reportFile;
}

function appendSpokenReplyTranscript(status, reportFile, options = {}) {
  if (!status || status.ok !== true || options.write_transcript === false) return [];
  const transcriptOptions = options.transcript_options || {};
  const written = [];
  const common = {
    source: 'spoken_reply_once',
    report_file: reportFile || null,
    hearing_report_file: status.hearing_report_file || null,
    bridge_report_file: status.bridge_report_file || null,
    spoken_reply_report_file: reportFile || null
  };
  if (status.heard_text) {
    written.push(appendChatTranscriptTurn({ ...common, role: 'user', text: status.heard_text, input_modality: 'spoken', output_modality: 'none', spoken_aloud: false }, transcriptOptions));
  }
  if (status.broca_text_response) {
    written.push(appendChatTranscriptTurn({ ...common, role: 'floki', text: status.broca_text_response, input_modality: 'spoken', output_modality: 'spoken', spoken_aloud: status.speaker_playback_run_now === true, piper_wav_output_file: status.piper_wav_output_file || null }, transcriptOptions));
  }
  if (status.safe_thought_summary) {
    written.push(appendPrivateThoughtRecord({ source: 'spoken_reply_once', text: status.safe_thought_summary, report_file: reportFile || null }, transcriptOptions));
  }
  return written.filter((entry) => entry && entry.written === true);
}

function ensurePiperWavReady(bridgeStatus) {
  if (!bridgeStatus || bridgeStatus.ok !== true) {
    throw new Error('hearing-to-cognition bridge did not pass');
  }

  if (bridgeStatus.marker !== 'FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_PASS') {
    throw new Error('bridge did not produce Piper WAV pass marker: ' + String(bridgeStatus.marker || 'missing'));
  }

  if (bridgeStatus.schema_constrained_json !== true) {
    throw new Error('schema-constrained cognition JSON was not proven');
  }

  if (bridgeStatus.model_json_fallback_used === true) {
    throw new Error('model JSON fallback is not allowed');
  }

  if (bridgeStatus.broca_enabled_now !== true || bridgeStatus.broca_text_response_created_now !== true) {
    throw new Error('Broca did not create a text response');
  }

  if (bridgeStatus.piper_speech_run_now !== true || bridgeStatus.piper_wav_created_now !== true) {
    throw new Error('Piper WAV was not created');
  }

  if (bridgeStatus.speaker_playback_run_now === true && bridgeStatus.low_latency_spoken_enabled !== true) {
    throw new Error('bridge stage must not play speakers before guarded playback stage');
  }

  const filePath = String(bridgeStatus.piper_wav_output_file || '').trim();

  if (!filePath) {
    throw new Error('bridge report missing piper_wav_output_file');
  }

  return filePath;
}

async function runSpokenReplyOnce(options = {}) {
  const guard = spokenReplyOnceGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_BLOCKED',
      guard,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      qwen_cognition_run_now: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      piper_wav_created_now: false,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      ears_open_after_playback: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeSpokenReplyReport(status, options)
    });
  }

  const hearingRunner = options.hearing_runner || runChatHearingLoopProof;
  const bridgeRunner = options.bridge_runner || runHearingToCognitionBridgeProof;
  const playbackRunner = options.locked_playback_runner || runPlaybackWithVoiceLock;

  const hearing = hearingRunner({
    env: {
      ...process.env,
      FLOKI_ALLOW_CHAT_HEARING_LOOP: '1'
    },
    seconds: options.seconds,
    device: options.device,
    rate: options.rate,
    channels: options.channels,
    whisper_model_size: options.whisper_model_size,
    input_file: options.input_file,
    voice_lock_file: options.voice_lock_file,
    voice_lock_now_ms: options.voice_lock_now_ms,
    report_file: options.hearing_report_file
  });

  if (!hearing || hearing.ok !== true) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_FAIL',
      reason: 'hearing loop failed before cognition',
      hearing,
      microphone_recorded_now: hearing ? hearing.microphone_recorded_now === true : false,
      microphone_capture_replay_used: hearing ? hearing.microphone_capture_replay_used === true : false,
      vad_audio_analysis_run_now: hearing ? hearing.vad_audio_analysis_run_now === true : false,
      whisper_transcription_run_now: hearing ? hearing.whisper_transcription_run_now === true : false,
      wake_gate_checked_now: false,
      qwen_cognition_run_now: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      piper_wav_created_now: false,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      ears_open_after_playback: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeSpokenReplyReport(status, options)
    });
  }

  const liveChat = getLiveChatConfig('chat');
  const cognitionModel = getModelConfig('chat').cognition;
  const pathConfig = getPathConfig('chat');
  const trace = options.latency_trace || createLatencyTrace({
    input_modality: 'spoken',
    configured_model: cognitionModel.model,
    configured_endpoint: cognitionModel.endpoint,
    schema_enabled: true,
    streaming_enabled: liveChat.public_response_streaming_enabled === true,
    log_path: path.join(ROOT, pathConfig.chat_runtime_root, 'latency-events.jsonl'),
    max_log_bytes: liveChat.latency_log_max_bytes,
    on_event: options.on_latency_event
  });
  trace.emit('request_accepted', { input_character_count: String(hearing.heard_text || '').length });
  const cachedVision = options.chat_webcam_vision !== undefined
    ? options.chat_webcam_vision
    : readLatestPrivateObservation();
  trace.emit('cached_vision_ready', {
    cached_vision_available: cachedVision && cachedVision.available === true,
    cached_vision_fresh: cachedVision && cachedVision.fresh === true
  });

  let earlySpokenPromise = null;
  function startEarlySpoken(payload) {
    if (earlySpokenPromise || liveChat.first_sentence_tts_enabled !== true) return;
    const text = String(payload && payload.text || '').trim();
    if (!text || options.signal && options.signal.aborted) return;
    const task = (async () => {
      trace.emit('tts_started', { tts_character_count: text.length });
      const speech = await (options.piper_synthesizer_async || synthesizePiperSpeechToFileAsync)({
        voice_size: options.voice_size || 'large',
        text,
        output_dir: options.piper_output_dir,
        signal: options.signal
      });
      trace.emit('tts_ready', {
        tts_character_count: text.length,
        audio_file_size_bytes: Number(speech.output_size_bytes || 0)
      });
      if (options.signal && options.signal.aborted) {
        const error = new Error('spoken response interrupted before playback');
        error.name = 'AbortError';
        throw error;
      }
      trace.emit('playback_started', { audio_file_size_bytes: Number(speech.output_size_bytes || 0) });
      const lockedPlayback = await (options.locked_playback_runner_async || runPlaybackWithVoiceLockAsync)(speech.output_file, {
        output_id: speech.output_file,
        text_hash: 'spoken_stream_' + String(speech.output_size_bytes || 0)
      }, {
        voice_lock_file: options.voice_lock_file,
        voice_lock_start_now_ms: options.voice_lock_start_now_ms,
        voice_lock_end_now_ms: options.voice_lock_end_now_ms,
        voice_lock_ttl_ms: options.voice_lock_ttl_ms,
        playback_runner_async: options.playback_runner_async,
        signal: options.signal
      });
      return Object.freeze({ text, speech, locked_playback: lockedPlayback });
    })();
    earlySpokenPromise = task.then(
      (result) => Object.freeze({ ok: true, result }),
      (error) => Object.freeze({ ok: false, error })
    );
  }

  const bridge = await bridgeRunner({
    env: {
      ...process.env,
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    hearing_report_file: hearing.report_file,
    bridge_report_file: options.bridge_report_file,
    modality: 'spoken',
    source: 'user',
    voice_lock_file: options.voice_lock_file,
    voice_lock_now_ms: options.voice_lock_now_ms,
    piper_output_dir: options.piper_output_dir,
    voice_size: options.voice_size || 'large',
    write_report: options.write_bridge_report !== false,
    chat_webcam_vision: cachedVision,
    latency_trace: trace,
    signal: options.signal,
    streaming_enabled: liveChat.public_response_streaming_enabled === true,
    low_latency_spoken: liveChat.first_sentence_tts_enabled === true,
    on_public_text(payload) {
      startEarlySpoken(payload);
      if (typeof options.on_public_text === 'function') options.on_public_text(payload);
    },
    on_first_safe_sentence(payload) {
      if (typeof options.on_first_safe_sentence === 'function') options.on_first_safe_sentence(payload);
    },
    get_early_spoken_result: async function() {
      if (!earlySpokenPromise) return null;
      const settled = await earlySpokenPromise;
      if (!settled.ok) throw settled.error;
      return settled.result;
    }
  });

  const sleepInterruptionRecorder = options.sleep_interruption_recorder || recordWakeActivityIfSleeping;
  const sleepInterruption = bridge && bridge.wake_routed_to_cognition === true
    ? sleepInterruptionRecorder({
      env: options.env || process.env,
      now: options.sleep_now || options.now,
      state_file: options.sleep_state_file,
      events_file: options.sleep_events_file,
      reason: 'wake_gated_spoken_reply'
    })
    : null;

  const wavFile = ensurePiperWavReady(bridge);
  assertPublicTranscriptText(bridge.broca_text_response || '', 'spoken reply before Piper playback');

  if (!fs.existsSync(wavFile)) {
    throw new Error('Piper WAV file missing before speaker playback: ' + wavFile);
  }

  const lockedPlayback = bridge.low_latency_spoken_enabled === true && bridge.early_locked_playback
    ? bridge.early_locked_playback
    : playbackRunner(wavFile, {
      output_id: bridge.piper_wav_output_file,
      text_hash: 'spoken_reply_once_' + String(bridge.piper_wav_output_size_bytes || 0)
    }, {
      voice_lock_file: options.voice_lock_file,
      voice_lock_start_now_ms: options.voice_lock_start_now_ms,
      voice_lock_end_now_ms: options.voice_lock_end_now_ms,
      voice_lock_ttl_ms: options.voice_lock_ttl_ms,
      playback_runner: options.playback_runner
    });

  const ok = bridge.ok === true &&
    lockedPlayback &&
    lockedPlayback.ok === true &&
    lockedPlayback.ears_muted_during_playback === true &&
    lockedPlayback.voice_output_lock_cleared_after_playback === true &&
    lockedPlayback.ears_open_after_playback === true;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_SPOKEN_REPLY_ONCE_PASS' : 'FLOKI_V2_SPOKEN_REPLY_ONCE_FAIL',
    hearing_report_file: hearing.report_file || null,
    bridge_report_file: bridge.report_file || null,
    heard_text: bridge.original_heard_text || hearing.heard_text || '',
    capture_file: hearing.capture && hearing.capture.output_file ? hearing.capture.output_file : null,
    whisper_report_file: hearing.whisper && hearing.whisper.report_file ? hearing.whisper.report_file : null,
    wake_request_text: bridge.wake_request_text || '',
    wake_gate_marker: bridge.wake_gate_marker || null,
    wake_gate_open: bridge.wake_gate_open === true,
    wake_routed_to_cognition: bridge.wake_routed_to_cognition === true,
    cognition_model: bridge.cognition_model || null,
    cognition_type: bridge.cognition_type || null,
    schema_constrained_json: bridge.schema_constrained_json === true,
    model_json_fallback_used: bridge.model_json_fallback_used === true,
    safe_thought_summary: bridge.safe_thought_summary || '',
    broca_text_response: bridge.broca_text_response || '',
    piper_wav_output_file: wavFile,
    sleep_interruption: sleepInterruption,
    sleep_interrupted_by_wake: sleepInterruption ? sleepInterruption.sleep_interrupted_by_wake === true : false,
    piper_wav_output_ready: bridge.piper_wav_output_ready === true,
    piper_wav_output_size_bytes: Number(bridge.piper_wav_output_size_bytes || 0),
    piper_voice_size: bridge.piper_voice_size || null,
    piper_voice_name: bridge.piper_voice_name || null,
    locked_playback: lockedPlayback,
    microphone_recorded_now: hearing.microphone_recorded_now === true,
    microphone_capture_replay_used: hearing.microphone_capture_replay_used === true,
    vad_audio_analysis_run_now: hearing.vad_audio_analysis_run_now === true,
    whisper_transcription_run_now: hearing.whisper_transcription_run_now === true,
    wake_gate_checked_now: true,
    qwen_cognition_run_now: bridge.qwen_cognition_run_now === true,
    broca_enabled_now: bridge.broca_enabled_now === true,
    broca_text_response_created_now: bridge.broca_text_response_created_now === true,
    piper_speech_run_now: bridge.piper_speech_run_now === true,
    piper_wav_created_now: bridge.piper_wav_created_now === true,
    speaker_playback_run_now: lockedPlayback ? lockedPlayback.speaker_playback_run_now === true : false,
    voice_output_lock_started: lockedPlayback ? lockedPlayback.voice_output_lock_started === true : false,
    ears_muted_during_playback: lockedPlayback ? lockedPlayback.ears_muted_during_playback === true : false,
    voice_output_lock_cleared_after_playback: lockedPlayback ? lockedPlayback.voice_output_lock_cleared_after_playback === true : false,
    ears_open_after_playback: lockedPlayback ? lockedPlayback.ears_open_after_playback === true : false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    minecraft_called: false,
    chat_mode_only: true
  });

  if (trace && !trace.is_closed()) {
    trace.emit(ok ? 'response_completed' : 'response_failed', {
      completion_status: ok ? 'completed' : 'failed',
      response_character_count: String(status.broca_text_response || '').length,
      safe_public_text_length: String(status.broca_text_response || '').length,
      error_code: ok ? null : 'SPOKEN_REPLY_FAILED'
    });
  }

  const reportFile = writeSpokenReplyReport(status, options);
  const transcriptEntries = appendSpokenReplyTranscript(status, reportFile, options);

  return Object.freeze({
    ...status,
    report_file: reportFile,
    transcript_entries_written: transcriptEntries.length,
    transcript_jsonl_file: transcriptEntries.find((entry) => entry.transcript_jsonl_file) ? transcriptEntries.find((entry) => entry.transcript_jsonl_file).transcript_jsonl_file : null,
    transcript_text_file: transcriptEntries.find((entry) => entry.transcript_text_file) ? transcriptEntries.find((entry) => entry.transcript_text_file).transcript_text_file : null,
    private_thought_entries_written: transcriptEntries.filter((entry) => entry.private_thought_jsonl_file).length,
    private_thought_jsonl_file: transcriptEntries.find((entry) => entry.private_thought_jsonl_file) ? transcriptEntries.find((entry) => entry.private_thought_jsonl_file).private_thought_jsonl_file : null
  });
}

async function printSpokenReplyOnce() {
  const status = await runSpokenReplyOnce();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printSpokenReplyOnce().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_FAIL',
      error: error.message,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      qwen_cognition_run_now: false,
      broca_enabled_now: false,
      piper_speech_run_now: false,
      piper_wav_created_now: false,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      ears_open_after_playback: false,
      chat_mode_only: true
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  SPOKEN_REPLY_OUTPUT_DIR,
  spokenReplyOnceAllowed,
  spokenReplyOnceGuardStatus,
  writeSpokenReplyReport,
  ensurePiperWavReady,
  runSpokenReplyOnce,
  printSpokenReplyOnce
};
