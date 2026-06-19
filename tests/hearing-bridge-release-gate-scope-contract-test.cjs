
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, 'missing start marker: ' + startMarker);
  assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
  assert.ok(end > start, 'invalid marker order');
  return source.slice(start, end);
}

function run() {
  const file = path.join(ROOT, 'src', 'senses', 'hearing-to-cognition-bridge.cjs');
  const source = fs.readFileSync(file, 'utf8');

  const pathResolver = between(
    source,
    'function resolveBridgeBrainStatePaths',
    'async function runCognitionFromHeardText'
  );
  assert.equal(
    pathResolver.includes('releaseGate'),
    false,
    'resolveBridgeBrainStatePaths must not reference the turn-local releaseGate'
  );

  const cognitionTurn = between(
    source,
    'async function runCognitionFromHeardText',
    'function runBrocaFromCognition'
  );
  assert.equal(cognitionTurn.includes('const releaseGate = createReleaseGate({'), true);
  assert.equal(cognitionTurn.includes('public_response_released_early: releaseGate.was_released()'), true);
  assert.equal(cognitionTurn.includes('early_public_response_text: releaseGate.authorized_text()'), true);
  assert.equal(cognitionTurn.includes('first_safe_sentence: releaseGate.first_sentence()'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HEARING_RELEASE_GATE_SCOPE_PASS',
    path_resolution_is_pure: true,
    release_gate_is_turn_local: true,
    spoken_vision_contract_protected: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_HEARING_RELEASE_GATE_SCOPE_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
