'use strict';

const assert = require('node:assert/strict');
const { webcamCaptureConfig, capabilityStatusFromText } = require('../src/vision/webcam-capabilities.cjs');

const sample = [
  "ioctl: VIDIOC_ENUM_FMT",
  "  Type: Video Capture",
  "  [0]: \'MJPG\' (Motion-JPEG, compressed)",
  "    Size: Discrete 1280x720",
  "      Interval: Discrete 0.025s (40.000 fps)",
  "    Size: Discrete 640x480",
  "      Interval: Discrete 0.016s (60.000 fps)",
  "  [1]: \'YUYV\' (YUYV 4:2:2)",
  "    Size: Discrete 1280x720",
  "      Interval: Discrete 0.033s (30.000 fps)"
].join("\n");

const higherThanExactSample = [
  "ioctl: VIDIOC_ENUM_FMT",
  "  Type: Video Capture",
  "  [0]: 'MJPG' (Motion-JPEG, compressed)",
  "    Size: Discrete 1280x720",
  "      Interval: Discrete 0.016s (60.000 fps)"
].join("\n");

function run() {
  const capture = webcamCaptureConfig('chat');
  assert.equal(Number.isFinite(capture.target_fps), true);
  assert.equal(Number.isFinite(capture.target_width), true);
  assert.equal(Number.isFinite(capture.target_height), true);
  assert.equal(capture.target_fps, 40);
  const status = capabilityStatusFromText(sample, { mode: 'chat', capture_config: capture });
  assert.equal(status.ok, true);
  assert.equal(status.exact_target_supported, true);
  assert.equal(status.supported_modes.some((mode) => mode.pixel_format === capture.preferred_pixel_format && mode.width === capture.target_width && mode.height === capture.target_height && mode.fps === capture.target_fps), true);
  const higherThanExactStatus = capabilityStatusFromText(higherThanExactSample, { mode: 'chat', capture_config: capture });
  assert.equal(capture.require_exact_target_fps, true);
  assert.equal(higherThanExactStatus.exact_target_supported, false);
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_CONTRACT_PASS',
    target_from_yaml: true,
    device_from_yaml_or_env: true,
    exact_target_supported_fixture: true,
    higher_than_exact_rejected_when_yaml_requires_exact_fps: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
