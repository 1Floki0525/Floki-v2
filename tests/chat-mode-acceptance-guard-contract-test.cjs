'use strict';

const assert = require('node:assert/strict');

const {
  chatModeAcceptanceAllowed,
  chatModeAcceptanceGuardStatus,
  runChatModeAcceptanceProof
} = require('../src/chat/chat-mode-acceptance.cjs');

async function run() {
  assert.equal(chatModeAcceptanceAllowed({}), false);
  assert.equal(chatModeAcceptanceAllowed({ FLOKI_ALLOW_CHAT_MODE_ACCEPTANCE: '0' }), false);
  assert.equal(chatModeAcceptanceAllowed({ FLOKI_ALLOW_CHAT_MODE_ACCEPTANCE: '1' }), true);

  const guard = chatModeAcceptanceGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.acceptance_run_now, false);
  assert.equal(guard.microphone_recorded_now, false);
  assert.equal(guard.qwen_cognition_run_now, false);
  assert.equal(guard.speaker_playback_run_now, false);

  let runnerCalled = false;
  const blocked = await runChatModeAcceptanceProof({
    env: {},
    write_report: false,
    microphone_runner: function() {
      runnerCalled = true;
      throw new Error('acceptance must not touch microphone while guarded');
    }
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_BLOCKED');
  assert.equal(blocked.acceptance_run_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.qwen_cognition_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.npm_test_run_now, false);
  assert.equal(runnerCalled, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_GUARD_PASS',
    requires_explicit_env: true,
    blocked_without_env: true,
    microphone_recorded_now: false,
    qwen_cognition_run_now: false,
    speaker_playback_run_now: false,
    npm_test_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_GUARD_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
