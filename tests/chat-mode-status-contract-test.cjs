'use strict';

const assert = require('node:assert/strict');

const {
  buildChatModeStatus
} = require('../src/chat/chat-mode-status.cjs');

function run() {
  const status = buildChatModeStatus();

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_MODE_STATUS_PASS');
  assert.equal(status.microphone_readiness.configured_source, 'microphone');
  assert.equal(status.microphone_readiness.always_listening_expected, true);
  assert.equal(status.microphone_readiness.transcribe_all_heard_audio_expected, true);
  assert.equal(status.microphone_readiness.reply_only_when_wake_gated, true);
  assert.equal(status.microphone_readiness.mic_disabled_only_while_floki_speaks, true);
  assert.equal(status.microphone_readiness.mute_while_voice_is_speaking, true);
  assert.equal(status.microphone_readiness.microphone_recorded_now, false);
  assert.equal(status.vad_readiness.package_import_ready, true);
  assert.equal(status.vad_readiness.vad_audio_analysis_run_now, false);
  assert.equal(status.whisper_readiness.cli_ready, true);
  assert.equal(status.whisper_readiness.small_en_model_ready, true);
  assert.equal(status.whisper_readiness.whisper_transcription_run_now, false);
  assert.ok(typeof status.qwen_cognition.model === 'string' && status.qwen_cognition.model.length > 0, 'qwen_cognition model from YAML must be non-empty');
  assert.equal(status.qwen_cognition.schema_constrained_json_required, true);
  assert.equal(status.qwen_cognition.qwen_cognition_run_now, false);
  assert.equal(status.broca_ready.required_for_speech, true);
  assert.equal(status.broca_ready.broca_enabled_now, false);
  assert.equal(status.piper_voice.ready, true);
  assert.equal(status.piper_voice.name, 'en_US-ryan-high');
  assert.equal(status.speaker_playback_guard.allowed_now, false);
  assert.equal(status.speaker_playback_guard.speaker_playback_run_now, false);
  assert.equal(status.voice_output_lock_state.ok, true);
  assert.equal(status.wake_word_config.required_phrase, 'hey floki');
  assert.equal(status.memory_substrate_paths.short_term_path.endsWith('/short-term.jsonl'), true);
  assert.equal(typeof status.memory_substrate_paths.short_term_count, 'number');
  assert.equal(status.emotion_reinforcement_state_summary.reinforcement_path.endsWith('/reinforcement-events.jsonl'), true);
  assert.equal(status.personality_identity_state_summary.personality_path.endsWith('/personality.json'), true);
  assert.equal(status.latest_reports.hearing.path.endsWith('/latest-chat-hearing-loop.json'), true);
  assert.equal(status.latest_reports.spoken_reply.path.endsWith('/latest-spoken-reply-once.json'), true);
  assert.equal(status.latest_reports.loop.path.endsWith('/latest-chat-mode-loop.json'), true);
  assert.equal(typeof status.chat_mode_active, 'boolean');
  assert.equal(status.game_mode_explicitly_out_of_scope, true);
  assert.equal(status.game_mode_started, false);
  assert.equal(status.minecraft_called, false);
  assert.equal(status.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_STATUS_PASS',
    microphone_ready: status.microphone_readiness.toolchain_ready,
    vad_ready: status.vad_readiness.package_import_ready,
    whisper_ready: status.whisper_readiness.cli_ready,
    qwen_model: status.qwen_cognition.model,
    broca_ready: status.broca_ready.required_for_speech,
    piper_voice: status.piper_voice.name,
    speaker_guard_allowed_now: status.speaker_playback_guard.allowed_now,
    voice_output_lock_active: status.voice_output_lock_state.voice_output_lock_active,
    wake_phrase: status.wake_word_config.required_phrase,
    latest_hearing_report: status.latest_hearing_report,
    latest_spoken_reply_report: status.latest_spoken_reply_report,
    latest_loop_report: status.latest_loop_report,
    chat_mode_active: status.chat_mode_active,
    game_mode_explicitly_out_of_scope: status.game_mode_explicitly_out_of_scope,
    chat_mode_only: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_STATUS_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
