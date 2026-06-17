'use strict';

const assert = require('node:assert/strict');

const {
  microphoneCaptureAllowed,
  microphoneCaptureGuardStatus,
  buildArecordArgs,
  runMicrophoneCaptureProof
} = require('../src/senses/microphone-capture-smoke.cjs');

function run() {
  assert.equal(microphoneCaptureAllowed({}), false);
  assert.equal(microphoneCaptureAllowed({ FLOKI_ALLOW_MICROPHONE_CAPTURE: '0' }), false);
  assert.equal(microphoneCaptureAllowed({ FLOKI_ALLOW_MICROPHONE_CAPTURE: '1' }), true);

  const guard = microphoneCaptureGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_MICROPHONE_CAPTURE_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.microphone_recorded_now, false);

  const blocked = runMicrophoneCaptureProof({
    env: {},
    output_file: '/tmp/floki-microphone-capture-should-not-exist.wav'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_MICROPHONE_CAPTURE_BLOCKED');
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.whisper_transcription_run_now, false);
  assert.equal(blocked.yolo_inference_run_now, false);
  assert.equal(blocked.vad_audio_analysis_run_now, false);
  assert.equal(blocked.minecraft_called, false);

  const plan = buildArecordArgs({
    output_file: '/tmp/floki-microphone-plan.wav',
    device: 'default',
    seconds: 3,
    rate: 16000,
    channels: 1
  });

  assert.equal(plan.device, 'default');
  assert.equal(plan.seconds, 3);
  assert.equal(plan.rate, 16000);
  assert.equal(plan.channels, 1);
  assert.equal(plan.args.includes('arecord'), false);
  assert.equal(plan.args.includes('/tmp/floki-microphone-plan.wav'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_MICROPHONE_CAPTURE_GUARD_PASS',
    default_capture_allowed: false,
    explicit_capture_env_required: 'FLOKI_ALLOW_MICROPHONE_CAPTURE=1',
    blocked_without_env: true,
    microphone_recorded_now: false,
    speaker_playback_run_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
