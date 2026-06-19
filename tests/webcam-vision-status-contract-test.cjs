'use strict';

const assert = require('node:assert/strict');
const { webcamVisionStatus } = require('../src/vision/webcam-vision-status.cjs');

function run() {
  const status = webcamVisionStatus('chat');
  assert.equal(status.ok, true);
  assert.equal(status.webcam_device_configured, true);
  assert.equal(status.requested_target_mode.fps, 40);
  assert.equal(status.forty_fps_required_by_yaml, true);
  assert.equal(status.fake_green_status, false);
  assert.equal(status.chat_mode_only, true);
  assert.equal(status.game_mode_started, false);
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_VISION_STATUS_CONTRACT_PASS',
    vision_status_reports_40fps_requirement: true,
    no_fake_green_status: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
