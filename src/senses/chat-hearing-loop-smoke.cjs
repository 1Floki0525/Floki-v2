'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  runMicrophoneCaptureProof
} = require('./microphone-capture-smoke.cjs');

const {
  runVadSpeechDetectionProof
} = require('./vad-speech-detection.cjs');

const {
  runWhisperTranscriptionProof
} = require('./whisper-transcription-smoke.cjs');

const { createVoiceOutputLock } = require('../chat/voice-output-lock.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const HEARING_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'chat-hearing-loop');

function voiceOutputEarsStatus(options = {}) {
  const lock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  });

  const local = {};

  if (typeof options.voice_lock_now_ms === 'number') {
    local.now_ms = options.voice_lock_now_ms;
  }

  return lock.isEarsMuted(local);
}

function chatHearingLoopAllowed(env = process.env) {
  return env.FLOKI_ALLOW_CHAT_HEARING_LOOP === '1';
}

function chatHearingLoopGuardStatus(env = process.env) {
  const allowed = chatHearingLoopAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_CHAT_HEARING_LOOP=1',
    chat_hearing_loop_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    qwen_called: false,
    broca_called: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    minecraft_called: false,
    reason: allowed
      ? 'Chat hearing loop is explicitly allowed for this one proof run.'
      : 'Chat hearing loop is guarded. Run npm run proof:chat-hearing-loop to record, detect speech, and transcribe once.'
  });
}

function writeHearingLoopReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const outputDir = options.output_dir || HEARING_OUTPUT_DIR;
  const reportFile = options.report_file ||
    options.hearing_report_file ||
    path.join(outputDir, 'latest-chat-hearing-loop.json');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
}

function compactCapture(capture) {
  return Object.freeze({
    ok: capture.ok === true,
    marker: capture.marker,
    device: capture.device,
    seconds: capture.seconds,
    rate: capture.rate,
    channels: capture.channels,
    format: capture.format,
    output_file: capture.output_file,
    output_ready: capture.output_ready,
    output_size_bytes: capture.output_size_bytes,
    riff_header: capture.riff_header,
    wave_header: capture.wave_header,
    microphone_recorded_now: capture.microphone_recorded_now === true,
    microphone_capture_replay_used: capture.microphone_capture_replay_used === true,
    real_microphone_capture_file: capture.real_microphone_capture_file === true
  });
}

function compactVad(vad) {
  return Object.freeze({
    ok: vad.ok === true,
    marker: vad.marker,
    input_file: vad.input_file,
    speech_detected: vad.speech_detected === true,
    speech_segment_count: Number(vad.speech_segment_count || 0),
    total_speech_seconds: Number(vad.total_speech_seconds || 0),
    duration_seconds: Number(vad.duration_seconds || 0),
    report_file: vad.report_file,
    vad_audio_analysis_run_now: vad.vad_audio_analysis_run_now === true
  });
}

function compactWhisper(whisper) {
  return Object.freeze({
    ok: whisper.ok === true,
    marker: whisper.marker,
    input_file: whisper.input_file,
    model_size: whisper.model_size,
    model_file: whisper.model_file,
    report_file: whisper.report_file,
    transcription_text: whisper.transcription_text || '',
    transcription_length: Number(whisper.transcription_length || 0),
    transcription_word_count: Number(whisper.transcription_word_count || 0),
    whisper_transcription_run_now: whisper.whisper_transcription_run_now === true
  });
}

function runChatHearingLoopProof(options = {}) {
  const guard = chatHearingLoopGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_BLOCKED',
      guard,
      chat_hearing_loop_run_now: false,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      qwen_called: false,
      broca_called: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      minecraft_called: false
    });
  }

  const ears = voiceOutputEarsStatus(options);

  if (ears.ears_muted_now) {
    const status = Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_EARS_MUTED_WHILE_SPEAKING',
      ears,
      voice_output_lock_active: ears.voice_output_lock_active === true,
      ears_muted_now: true,
      chat_hearing_loop_run_now: true,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      qwen_called: false,
      broca_called: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      minecraft_called: false,
      chat_mode_only: true
    });

    return Object.freeze({
      ...status,
      report_file: writeHearingLoopReport(status, options)
    });
  }

  const captureSeconds = Number(options.seconds || process.env.FLOKI_HEARING_CAPTURE_SECONDS || 4);
  const replayInputFile = String(options.input_file || process.env.FLOKI_HEARING_INPUT_WAV || '').trim();
  let capture;

  if (replayInputFile) {
    const exists = fs.existsSync(replayInputFile);
    const fileBuffer = exists ? fs.readFileSync(replayInputFile) : Buffer.alloc(0);
    const header = fileBuffer.subarray(0, 12);
    const riffHeader = header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'RIFF';
    const waveHeader = header.length >= 12 && header.subarray(8, 12).toString('ascii') === 'WAVE';
    const size = exists ? fs.statSync(replayInputFile).size : 0;
    const ready = exists && riffHeader && waveHeader && size > 44;

    capture = Object.freeze({
      ok: ready,
      marker: ready
        ? 'FLOKI_V2_MICROPHONE_CAPTURE_REPLAY_INPUT_PASS'
        : 'FLOKI_V2_MICROPHONE_CAPTURE_REPLAY_INPUT_FAIL',
      device: 'replay_real_microphone_capture',
      seconds: captureSeconds,
      rate: Number(options.rate || process.env.FLOKI_MIC_RATE || 16000),
      channels: Number(options.channels || process.env.FLOKI_MIC_CHANNELS || 1),
      format: 'S16_LE',
      output_file: replayInputFile,
      output_ready: exists,
      output_size_bytes: size,
      riff_header: riffHeader,
      wave_header: waveHeader,
      microphone_recorded_now: false,
      microphone_capture_replay_used: true,
      real_microphone_capture_file: true
    });
  } else {
    capture = runMicrophoneCaptureProof({
      env: {
        ...process.env,
        FLOKI_ALLOW_MICROPHONE_CAPTURE: '1'
      },
      device: options.device || process.env.FLOKI_MIC_DEVICE || 'default',
      seconds: captureSeconds,
      rate: Number(options.rate || process.env.FLOKI_MIC_RATE || 16000),
      channels: Number(options.channels || process.env.FLOKI_MIC_CHANNELS || 1)
    });
  }

  if (!capture.ok) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_FAIL',
      reason: 'microphone capture failed',
      capture: compactCapture(capture),
      chat_hearing_loop_run_now: true,
      microphone_recorded_now: capture.microphone_recorded_now === true,
      microphone_capture_replay_used: capture.microphone_capture_replay_used === true,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      qwen_called: false,
      broca_called: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      minecraft_called: false
    });

    return Object.freeze({
      ...status,
      report_file: writeHearingLoopReport(status, options)
    });
  }

  const vad = runVadSpeechDetectionProof({
    env: {
      ...process.env,
      FLOKI_ALLOW_VAD_ANALYSIS: '1'
    },
    input_file: capture.output_file
  });

  if (!vad.ok) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_HEARING_LOOP_FAIL',
      reason: 'vad speech detection failed',
      capture: compactCapture(capture),
      vad: compactVad(vad),
      chat_hearing_loop_run_now: true,
      microphone_recorded_now: capture.microphone_recorded_now === true,
      microphone_capture_replay_used: capture.microphone_capture_replay_used === true,
      vad_audio_analysis_run_now: vad.vad_audio_analysis_run_now === true,
      whisper_transcription_run_now: false,
      qwen_called: false,
      broca_called: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      yolo_inference_run_now: false,
      minecraft_called: false
    });

    return Object.freeze({
      ...status,
      report_file: writeHearingLoopReport(status, options)
    });
  }

  const whisper = runWhisperTranscriptionProof({
    env: {
      ...process.env,
      FLOKI_ALLOW_WHISPER_TRANSCRIPTION: '1'
    },
    input_file: capture.output_file,
    model_size: options.whisper_model_size || process.env.FLOKI_WHISPER_MODEL_SIZE || 'small'
  });

  const transcript = String(whisper.transcription_text || '').trim();
  const ok = capture.ok === true &&
    vad.ok === true &&
    whisper.ok === true &&
    transcript.length > 0;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_HEARING_LOOP_PASS' : 'FLOKI_V2_CHAT_HEARING_LOOP_FAIL',
    capture: compactCapture(capture),
    vad: compactVad(vad),
    whisper: compactWhisper(whisper),
    heard_text: transcript,
    heard_text_length: transcript.length,
    heard_word_count: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0,
    chat_hearing_loop_run_now: true,
    microphone_recorded_now: capture.microphone_recorded_now === true,
    microphone_capture_replay_used: capture.microphone_capture_replay_used === true,
    vad_audio_analysis_run_now: vad.vad_audio_analysis_run_now === true,
    whisper_transcription_run_now: whisper.whisper_transcription_run_now === true,
    qwen_called: false,
    broca_called: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    minecraft_called: false
  });

  return Object.freeze({
    ...status,
    report_file: writeHearingLoopReport(status, options)
  });
}

function printChatHearingLoopProof() {
  const status = runChatHearingLoopProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatHearingLoopProof();
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  HEARING_OUTPUT_DIR,
  voiceOutputEarsStatus,
  chatHearingLoopAllowed,
  chatHearingLoopGuardStatus,
  writeHearingLoopReport,
  compactCapture,
  compactVad,
  compactWhisper,
  runChatHearingLoopProof,
  printChatHearingLoopProof
};
