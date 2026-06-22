'use strict';

const assert = require('node:assert/strict');

const {
  buildChatToolchainReadinessStatus
} = require('../src/senses/chat-toolchain-readiness.cjs');

function requireBoolean(value, label) {
  assert.equal(typeof value, 'boolean', label + ' must be boolean');
}

function expectedReadiness(status) {
  return status.python_venv_ready === true &&
    status.whisper.cli_ready === true &&
    status.whisper.tiny_en_model_ready === true &&
    status.whisper.small_en_model_ready === true &&
    status.piper.cli_ready === true &&
    status.piper.voices.tiny.ready === true &&
    status.piper.voices.small.ready === true &&
    status.piper.voices.med.ready === true &&
    status.piper.voices.large.ready === true &&
    status.vad.package_import_ready === true &&
    status.yolo.package_import_ready === true &&
    status.yolo.model_ready === true;
}

function run() {
  const status = buildChatToolchainReadinessStatus();
  const readyNow = expectedReadiness(status);

  requireBoolean(status.ok, 'status.ok');
  requireBoolean(status.python_venv_ready, 'python_venv_ready');
  requireBoolean(status.whisper.cli_ready, 'whisper.cli_ready');
  requireBoolean(status.whisper.tiny_en_model_ready, 'whisper.tiny_en_model_ready');
  requireBoolean(status.whisper.small_en_model_ready, 'whisper.small_en_model_ready');
  requireBoolean(status.piper.cli_ready, 'piper.cli_ready');
  requireBoolean(status.piper.voices.tiny.ready, 'piper.voices.tiny.ready');
  requireBoolean(status.piper.voices.small.ready, 'piper.voices.small.ready');
  requireBoolean(status.piper.voices.med.ready, 'piper.voices.med.ready');
  requireBoolean(status.piper.voices.large.ready, 'piper.voices.large.ready');
  requireBoolean(status.vad.package_import_ready, 'vad.package_import_ready');
  requireBoolean(status.yolo.package_import_ready, 'yolo.package_import_ready');
  requireBoolean(status.yolo.model_ready, 'yolo.model_ready');

  assert.equal(status.ok, readyNow);
  assert.equal(
    status.marker,
    readyNow
      ? 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_PASS'
      : 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_FAIL'
  );

  assert.equal(typeof status.tools_dir, 'string');
  assert.equal(typeof status.whisper.cli_path, 'string');
  assert.equal(typeof status.piper.cli_path, 'string');
  assert.equal(typeof status.yolo.model_path, 'string');

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
    marker: 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_CONTRACT_PASS',
    toolchain_ready_now: status.ok,
    readiness_marker: status.marker,
    readiness_matches_all_required_components: true,
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
    runtime_services_started_now: false,
    chat_mode_only: true
  }, null, 2));
}

run();
