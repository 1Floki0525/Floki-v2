'use strict';

const assert = require('node:assert/strict');

const {
  spokenReplyOnceGuardStatus,
  runSpokenReplyOnce
} = require('../src/senses/spoken-reply-once.cjs');

async function run() {
  const guard = spokenReplyOnceGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.required_env, 'FLOKI_ALLOW_SPOKEN_REPLY_ONCE=1');
  assert.equal(guard.microphone_recorded_now, false);
  assert.equal(guard.speaker_playback_run_now, false);

  const status = await runSpokenReplyOnce({
    env: {},
    write_report: false
  });

  assert.equal(status.ok, false);
  assert.equal(status.marker, 'FLOKI_V2_SPOKEN_REPLY_ONCE_BLOCKED');
  assert.equal(status.microphone_recorded_now, false);
  assert.equal(status.vad_audio_analysis_run_now, false);
  assert.equal(status.whisper_transcription_run_now, false);
  assert.equal(status.qwen_cognition_run_now, false);
  assert.equal(status.broca_enabled_now, false);
  assert.equal(status.piper_speech_run_now, false);
  assert.equal(status.speaker_playback_run_now, false);
  assert.equal(status.voice_output_lock_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_GUARD_CONTRACT_PASS',
    requires_explicit_env: true,
    blocked_without_recording: true,
    blocked_without_qwen: true,
    blocked_without_speaker_playback: true,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SPOKEN_REPLY_ONCE_GUARD_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
