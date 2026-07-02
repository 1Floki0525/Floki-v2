'use strict';

const assert = require('node:assert/strict');

const {
  webcamCaptureAllowed,
  webcamEyesStreamGuardStatus,
  resolveWebcamDevice,
  runWebcamEyesStreamProof
} = require('../src/vision/webcam-eyes-stream.cjs');
const { getVisionConfig } = require('../src/config/floki-config.cjs');

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  const vision = getVisionConfig('chat');
  assert.equal(webcamCaptureAllowed({}), false);
  assert.equal(webcamCaptureAllowed({ [vision.webcam_capture_allow_env]: '1' }), false);
  assert.equal(webcamCaptureAllowed({ [vision.chat_vision_allow_env]: '1' }), false);
  assert.equal(webcamCaptureAllowed({ [vision.webcam_capture_allow_env]: '1', [vision.chat_vision_allow_env]: '1' }), true);

  const envDevice = 'contract-camera-device';
  const device = resolveWebcamDevice({ env: { [vision.webcam_device_env]: envDevice } });
  assert.equal(device.device, envDevice);
  assert.equal(device.source, 'env');

  const guard = webcamEyesStreamGuardStatus({});
  assert.equal(guard.marker, 'FLOKI_V2_WEBCAM_EYES_STREAM_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.webcam_opened_now, false);
  assert.equal(guard.desktop_screenshot_run_now, false);
  assert.equal(guard.host_screenshot_vision, false);

  const blocked = runWebcamEyesStreamProof({ env: {} });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_WEBCAM_EYES_STREAM_BLOCKED');
  assert.equal(blocked.frame_capture_run_now, false);
  assert.equal(blocked.webcam_opened_now, false);
  assert.equal(blocked.desktop_screenshot_run_now, false);
  assert.equal(blocked.public_transcript_visible, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_GUARD_PASS',
    blocked_without_env: true,
    required_env: guard.required_env,
    webcam_opened_now: false,
    frame_capture_run_now: false,
    desktop_screenshot_run_now: false,
    host_screenshot_vision: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_GUARD_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
