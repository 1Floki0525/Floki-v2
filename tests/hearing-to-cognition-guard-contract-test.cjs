'use strict';

const assert = require('node:assert/strict');

const {
  hearingToCognitionAllowed,
  hearingToCognitionGuardStatus,
  runHearingToCognitionBridgeProof
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

async function run() {
  assert.equal(hearingToCognitionAllowed({}), false);
  assert.equal(hearingToCognitionAllowed({ FLOKI_ALLOW_HEARING_TO_COGNITION: '0' }), false);
  assert.equal(hearingToCognitionAllowed({ FLOKI_ALLOW_HEARING_TO_COGNITION: '1' }), true);

  const guard = hearingToCognitionGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_HEARING_TO_COGNITION_GUARDED');
  assert.equal(guard.allowed_now, false);

  assert.equal(guard.hearing_to_cognition_run_now, false);
  assert.equal(guard.qwen_cognition_run_now, false);
  assert.equal(guard.broca_enabled_now, false);
  assert.equal(guard.piper_speech_run_now, false);
  assert.equal(guard.speaker_playback_run_now, false);
  assert.equal(guard.webcam_opened_now, false);
  assert.equal(guard.yolo_inference_run_now, false);
  assert.equal(guard.chat_mode_only, true);

  const blocked = await runHearingToCognitionBridgeProof({
    env: {},
    report_file: '/tmp/floki-hearing-cognition-should-not-read.json'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_HEARING_TO_COGNITION_BLOCKED');
  assert.equal(blocked.hearing_to_cognition_run_now, false);
  assert.equal(blocked.qwen_cognition_run_now, false);
  assert.equal(blocked.broca_enabled_now, false);
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.webcam_opened_now, false);
  assert.equal(blocked.yolo_inference_run_now, false);
  assert.equal(blocked.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HEARING_TO_COGNITION_GUARD_PASS',
    default_bridge_allowed: false,
    explicit_bridge_env_required: 'FLOKI_ALLOW_HEARING_TO_COGNITION=1',
    blocked_without_env: true,
    hearing_to_cognition_run_now: false,
    qwen_cognition_run_now: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    yolo_inference_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_HEARING_TO_COGNITION_GUARD_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
