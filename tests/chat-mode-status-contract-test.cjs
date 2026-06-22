'use strict';

const assert = require('node:assert/strict');

const {
  buildChatModeStatus
} = require('../src/chat/chat-mode-status.cjs');

function requireBoolean(value, label) {
  assert.equal(typeof value, 'boolean', label + ' must be boolean');
}

function run() {
  const status = buildChatModeStatus();

  requireBoolean(status.ok, 'status.ok');
  requireBoolean(
    status.microphone_readiness.toolchain_ready,
    'microphone_readiness.toolchain_ready'
  );
  requireBoolean(
    status.vad_readiness.package_import_ready,
    'vad_readiness.package_import_ready'
  );
  requireBoolean(
    status.whisper_readiness.cli_ready,
    'whisper_readiness.cli_ready'
  );
  requireBoolean(
    status.whisper_readiness.tiny_en_model_ready,
    'whisper_readiness.tiny_en_model_ready'
  );
  requireBoolean(
    status.whisper_readiness.small_en_model_ready,
    'whisper_readiness.small_en_model_ready'
  );
  requireBoolean(status.piper_voice.ready, 'piper_voice.ready');

  const expectedReady = status.microphone_readiness.toolchain_ready === true &&
    status.vad_readiness.package_import_ready === true &&
    status.whisper_readiness.cli_ready === true &&
    status.whisper_readiness.small_en_model_ready === true &&
    status.piper_voice.ready === true;

  assert.equal(status.ok, expectedReady);
  assert.equal(
    status.marker,
    expectedReady
      ? 'FLOKI_V2_CHAT_MODE_STATUS_PASS'
      : 'FLOKI_V2_CHAT_MODE_STATUS_FAIL'
  );

  assert.equal(status.microphone_readiness.configured_source, 'microphone');
  assert.equal(status.microphone_readiness.always_listening_expected, true);
  assert.equal(status.microphone_readiness.transcribe_all_heard_audio_expected, true);
  assert.equal(status.microphone_readiness.reply_only_when_wake_gated, true);
  assert.equal(status.microphone_readiness.mic_disabled_only_while_floki_speaks, true);
  assert.equal(status.microphone_readiness.mute_while_voice_is_speaking, true);
  assert.equal(status.microphone_readiness.microphone_recorded_now, false);
  assert.equal(status.vad_readiness.vad_audio_analysis_run_now, false);
  assert.equal(status.whisper_readiness.whisper_transcription_run_now, false);

  assert.ok(
    typeof status.qwen_cognition.model === 'string' &&
      status.qwen_cognition.model.length > 0,
    'qwen_cognition model from YAML must be non-empty'
  );
  assert.equal(status.qwen_cognition.schema_constrained_json_required, true);
  assert.equal(status.qwen_cognition.qwen_cognition_run_now, false);
  assert.equal(status.broca_ready.required_for_speech, true);
  assert.equal(status.broca_ready.broca_enabled_now, false);

  assert.equal(status.piper_voice.name, 'en_US-ryan-high');
  assert.equal(status.piper_voice.piper_speech_run_now, false);
  assert.equal(status.speaker_playback_guard.allowed_now, false);
  assert.equal(status.speaker_playback_guard.speaker_playback_run_now, false);
  assert.equal(status.voice_output_lock_state.ok, true);
  assert.equal(status.wake_word_config.required_phrase, 'hey floki');

  assert.equal(
    status.memory_substrate_paths.short_term_path.endsWith('/short-term.jsonl'),
    true
  );
  assert.equal(typeof status.memory_substrate_paths.short_term_count, 'number');
  assert.equal(
    status.emotion_reinforcement_state_summary.reinforcement_path.endsWith(
      '/reinforcement-events.jsonl'
    ),
    true
  );
  assert.equal(
    status.personality_identity_state_summary.personality_path.endsWith(
      '/personality.json'
    ),
    true
  );
  assert.equal(
    status.latest_reports.hearing.path.endsWith('/latest-chat-hearing-loop.json'),
    true
  );
  assert.equal(
    status.latest_reports.spoken_reply.path.endsWith(
      '/latest-spoken-reply-once.json'
    ),
    true
  );
  assert.equal(
    status.latest_reports.loop.path.endsWith('/latest-chat-mode-loop.json'),
    true
  );

  assert.equal(typeof status.chat_mode_active, 'boolean');
  assert.equal(status.game_mode_explicitly_out_of_scope, true);
  assert.equal(status.game_mode_started, false);
  assert.equal(status.minecraft_called, false);
  assert.equal(status.webcam_opened_now, false);
  assert.equal(status.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_STATUS_CONTRACT_PASS',
    runtime_status_ok: status.ok,
    runtime_status_marker: status.marker,
    readiness_matches_reported_status: true,
    microphone_toolchain_ready: status.microphone_readiness.toolchain_ready,
    vad_ready: status.vad_readiness.package_import_ready,
    whisper_ready: status.whisper_readiness.cli_ready,
    piper_voice_ready: status.piper_voice.ready,
    qwen_model: status.qwen_cognition.model,
    runtime_services_started_now: false,
    game_mode_started: false,
    chat_mode_only: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_STATUS_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
