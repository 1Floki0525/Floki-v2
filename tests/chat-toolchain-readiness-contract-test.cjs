'use strict';

const assert = require('node:assert/strict');

const {
  buildChatToolchainReadinessStatus
} = require('../src/senses/chat-toolchain-readiness.cjs');

function run() {
  const status = buildChatToolchainReadinessStatus();

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_PASS');

  assert.equal(status.python_venv_ready, true);

  assert.equal(status.whisper.cli_ready, true);
  assert.equal(status.whisper.tiny_en_model_ready, true);
  assert.equal(status.whisper.small_en_model_ready, true);

  assert.equal(status.piper.cli_ready, true);
  assert.equal(status.piper.voices.tiny.ready, true);
  assert.equal(status.piper.voices.small.ready, true);
  assert.equal(status.piper.voices.med.ready, true);
  assert.equal(status.piper.voices.large.ready, true);

  assert.equal(status.vad.package_import_ready, true);

  assert.equal(status.yolo.package_import_ready, true);
  assert.equal(status.yolo.model_ready, true);

  assert.equal(status.runtime_capture_enabled_now, false);
  assert.equal(status.webcam_opened_now, false);
  assert.equal(status.microphone_recorded_now, false);
  assert.equal(status.whisper_transcription_run_now, false);
  assert.equal(status.yolo_inference_run_now, false);
  assert.equal(status.vad_audio_analysis_run_now, false);
  assert.equal(status.piper_speech_run_now, false);
  assert.equal(status.minecraft_called, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_PASS',
    python_venv_ready: status.python_venv_ready,
    whisper_cli_ready: status.whisper.cli_ready,
    whisper_tiny_en_model_ready: status.whisper.tiny_en_model_ready,
    whisper_small_en_model_ready: status.whisper.small_en_model_ready,
    piper_cli_ready: status.piper.cli_ready,
    piper_voice_tiny_ready: status.piper.voices.tiny.ready,
    piper_voice_small_ready: status.piper.voices.small.ready,
    piper_voice_med_ready: status.piper.voices.med.ready,
    piper_voice_large_ready: status.piper.voices.large.ready,
    vad_package_import_ready: status.vad.package_import_ready,
    yolo_package_import_ready: status.yolo.package_import_ready,
    yolo_model_ready: status.yolo.model_ready,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    piper_speech_run_now: false
  }, null, 2));
}

run();
