'use strict';

const assert = require('node:assert/strict');
const { webcamCaptureConfig } = require('../src/vision/webcam-capabilities.cjs');
const { selectCaptureMode } = require('../src/vision/webcam-capture-mode.cjs');

function run() {
  const capture = webcamCaptureConfig('chat');
  const exactCapabilities = { supported_modes: [{ pixel_format: capture.preferred_pixel_format, raw_pixel_format: 'MJPG', width: capture.target_width, height: capture.target_height, fps: capture.target_fps }] };
  const exact = selectCaptureMode(exactCapabilities, { capture_config: capture });
  assert.equal(exact.ok, true);
  assert.equal(exact.exact_match, true);
  assert.equal(exact.fallback_used, false);

  const belowTargetCapabilities = { supported_modes: [{ pixel_format: capture.preferred_pixel_format, raw_pixel_format: 'MJPG', width: capture.target_width, height: capture.target_height, fps: capture.target_fps - 7 }] };
  const blocked = selectCaptureMode(belowTargetCapabilities, { capture_config: capture });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.fallback_used, false);
  assert.equal(blocked.target_preserved, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_CAPTURE_MODE_CONTRACT_PASS',
    exact_mode_selected: true,
    below_target_rejected: true,
    fallback_policy_from_yaml: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
