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
  runPlaybackWithVoiceLock
} = require('./piper-speaker-playback.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
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

  if (bridgeStatus.speaker_playback_run_now === true) {
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
    write_report: options.write_bridge_report !== false
  });

  const wavFile = ensurePiperWavReady(bridge);

  if (!fs.existsSync(wavFile)) {
    throw new Error('Piper WAV file missing before speaker playback: ' + wavFile);
  }

  const lockedPlayback = playbackRunner(wavFile, {
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

  return Object.freeze({
    ...status,
    report_file: writeSpokenReplyReport(status, options)
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
