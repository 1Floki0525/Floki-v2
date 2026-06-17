'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  applyWakeGateToHeardText,
  routedHeardText,
  runHearingToCognitionBridgeProof
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function writeFakeHearingReport(baseDir, heardText) {
  ensureDirSync(baseDir);
  const filePath = path.join(baseDir, 'fake-hearing-report.json');

  fs.writeFileSync(filePath, JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText.split(/\s+/).filter(Boolean).length,
    capture: {
      output_file: '/tmp/fake-capture.wav'
    },
    whisper: {
      report_file: '/tmp/fake-whisper.json'
    }
  }, null, 2) + '\n');

  return filePath;
}

async function run() {
  const addressed = {
    ok: true,
    heard_text: 'Hey Floki, remember that trust and hope matter.',
    heard_text_length: 47,
    heard_word_count: 8,
    report_file: '/tmp/fake-addressed.json'
  };

  const addressedGate = applyWakeGateToHeardText(addressed, {
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(addressedGate.ok, true);
  assert.equal(addressedGate.gate_open, true);
  assert.equal(addressedGate.routed_to_cognition, true);
  assert.equal(addressedGate.user_text_for_cognition, 'remember that trust and hope matter.');
  assert.equal(addressedGate.chat_mode_only, true);

  const routed = routedHeardText(addressed, addressedGate);

  assert.equal(routed.original_heard_text, addressed.heard_text);
  assert.equal(routed.heard_text, 'remember that trust and hope matter.');
  assert.equal(routed.heard_text_length, routed.heard_text.length);
  assert.equal(routed.heard_word_count, 6);

  const ignored = {
    ok: true,
    heard_text: 'remember that trust and hope matter.',
    heard_text_length: 36,
    heard_word_count: 6,
    report_file: '/tmp/fake-ignored.json'
  };

  const ignoredGate = applyWakeGateToHeardText(ignored, {
    modality: 'spoken',
    source: 'background'
  });

  assert.equal(ignoredGate.gate_open, false);
  assert.equal(ignoredGate.routed_to_cognition, false);
  assert.equal(ignoredGate.reason, 'wake_phrase_missing');

  const selfVoiceGate = applyWakeGateToHeardText(addressed, {
    modality: 'spoken',
    source: 'self_voice',
    voice_speaking: true
  });

  assert.equal(selfVoiceGate.gate_open, false);
  assert.equal(selfVoiceGate.routed_to_cognition, false);
  assert.equal(selfVoiceGate.ears_must_be_muted, true);

  const unique = newId('wake_gated_hearing').replace(/[^a-z0-9_]/g, '_');
  const reportFile = writeFakeHearingReport(
    statePath('test/wake-gated-hearing-to-cognition/' + unique),
    'background speech without the wake phrase'
  );

  const proof = await runHearingToCognitionBridgeProof({
    env: {
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    report_file: reportFile,
    modality: 'spoken',
    source: 'background'
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_IGNORED');
  assert.equal(proof.wake_gate_open, false);
  assert.equal(proof.qwen_cognition_run_now, false);
  assert.equal(proof.persistent_memory_used, false);
  assert.equal(proof.short_term_memory_written, false);
  assert.equal(proof.emotional_reinforcement_used, false);
  assert.equal(proof.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_CONTRACT_PASS',
    addressed_routes_to_cognition: addressedGate.routed_to_cognition,
    unaddressed_ignored_before_qwen: proof.qwen_cognition_run_now === false,
    self_voice_blocked: selfVoiceGate.routed_to_cognition === false,
    ears_muted_for_self_voice: selfVoiceGate.ears_must_be_muted,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
