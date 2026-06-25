'use strict';

const assert = require('node:assert/strict');
const { getAudioConfig, getWakeGateConfig } = require('../src/config/floki-config.cjs');
const { createWakeCommandContinuation } = require('../src/chat/wake-command-continuation.cjs');

function run() {
  const audio = getAudioConfig('chat');
  const wake = getWakeGateConfig('chat');
  const gate = createWakeCommandContinuation({ continuation_ms: audio.wake_command_continuation_ms });
  const start = Date.now();

  const attention = gate.processFinalTranscript({ text: wake.required_phrase, now_ms: start });
  assert.equal(attention.action, 'wait_for_command');
  assert.equal(gate.status(start).pending, true);

  const continued = gate.processFinalTranscript({ text: 'what can you see?', now_ms: start + 1 });
  assert.equal(continued.action, 'route');
  assert.equal(continued.request_text, 'what can you see?');
  assert.equal(continued.raw_text.toLowerCase(), wake.required_phrase.toLowerCase() + ', what can you see?');
  assert.equal(gate.status(start + 1).pending, false);

  gate.processFinalTranscript({ text: wake.required_phrase, now_ms: start });
  const expired = gate.processFinalTranscript({ text: 'what can you see?', now_ms: start + audio.wake_command_continuation_ms + 1 });
  assert.equal(expired.action, 'background');

  console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_WAKE_COMMAND_CONTINUATION_PASS', two_utterance_command_joined: true, expiry_verified: true }, null, 2));
}

try { run(); } catch (error) {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_WAKE_COMMAND_CONTINUATION_FAIL', error: error.stack || error.message }, null, 2));
  process.exit(1);
}
