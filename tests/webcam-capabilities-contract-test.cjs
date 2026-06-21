'use strict';

const assert = require('node:assert/strict');
const {
  webcamCaptureConfig,
  capabilityStatusFromText
} = require('../src/vision/webcam-capabilities.cjs');

function rawPixelFormat(normalized) {
  if (normalized === 'mjpeg') return 'MJPG';
  if (normalized === 'yuyv422') return 'YUYV';
  if (normalized === 'h264') return 'H264';
  throw new Error('unsupported fixture pixel format: ' + normalized);
}

function capabilityFixture(capture, fps) {
  const raw = rawPixelFormat(capture.preferred_pixel_format);
  const description = raw === 'MJPG'
    ? 'Motion-JPEG, compressed'
    : raw === 'YUYV'
      ? 'YUYV 4:2:2'
      : 'H.264';
  const seconds = (1 / Number(fps)).toFixed(6);

  return [
    'ioctl: VIDIOC_ENUM_FMT',
    '  Type: Video Capture',
    `  [0]: '${raw}' (${description})`,
    `    Size: Discrete ${capture.target_width}x${capture.target_height}`,
    `      Interval: Discrete ${seconds}s (${Number(fps).toFixed(3)} fps)`,
    "  [1]: 'MJPG' (Motion-JPEG, compressed)",
    '    Size: Discrete 640x480',
    '      Interval: Discrete 0.016667s (60.000 fps)'
  ].join('\n');
}

function run() {
  const capture = webcamCaptureConfig('chat');

  assert.equal(Number.isFinite(capture.target_fps), true);
  assert.equal(Number.isFinite(capture.target_width), true);
  assert.equal(Number.isFinite(capture.target_height), true);
  assert.equal(typeof capture.preferred_pixel_format, 'string');
  assert.notEqual(capture.preferred_pixel_format.length, 0);

  const exactSample = capabilityFixture(capture, capture.target_fps);
  const status = capabilityStatusFromText(exactSample, {
    mode: 'chat',
    capture_config: capture
  });

  assert.equal(status.ok, true);
  assert.equal(status.exact_target_supported, true);
  assert.equal(status.supported_modes.some((mode) => (
    mode.pixel_format === capture.preferred_pixel_format &&
    mode.width === capture.target_width &&
    mode.height === capture.target_height &&
    mode.fps === capture.target_fps
  )), true);

  const higherThanExactSample = capabilityFixture(
    capture,
    capture.target_fps + 20
  );
  const higherThanExactStatus = capabilityStatusFromText(
    higherThanExactSample,
    { mode: 'chat', capture_config: capture }
  );

  assert.equal(capture.require_exact_target_fps, true);
  assert.equal(higherThanExactStatus.exact_target_supported, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_CONTRACT_PASS',
    target_from_yaml: true,
    preferred_pixel_format_from_yaml: capture.preferred_pixel_format,
    target_fps_from_yaml: capture.target_fps,
    target_resolution_from_yaml:
      String(capture.target_width) + 'x' + String(capture.target_height),
    exact_target_supported_fixture: true,
    higher_than_exact_rejected_when_yaml_requires_exact_fps: true,
    fixture_is_config_driven: true,
    live_camera_capability_claimed: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
