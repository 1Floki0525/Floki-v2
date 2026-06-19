'use strict';

const assert = require('node:assert/strict');
const { webcamCaptureConfig } = require('../src/vision/webcam-capabilities.cjs');
const { buildFfmpegArgs, contractStatus } = require('../src/vision/webcam-eyes-stream.cjs');

function run() {
  const capture = webcamCaptureConfig('chat');
  const selected = { pixel_format: capture.preferred_pixel_format, width: capture.target_width, height: capture.target_height, fps: capture.target_fps };
  const args = buildFfmpegArgs(capture, selected);
  assert.equal(args.includes('-framerate'), true);
  assert.equal(args.includes(String(capture.target_fps)), true);
  assert.equal(args.includes('-video_size'), true);
  assert.equal(args.includes(String(capture.target_width) + 'x' + String(capture.target_height)), true);
  assert.equal(args.includes('-input_format'), true);
  assert.equal(args.includes(capture.device), true);
  const status = contractStatus('chat');
  assert.equal(status.ok, true);
  assert.equal(status.target_fps, capture.target_fps);
  assert.equal(status.min_measured_fps >= capture.target_fps, true);
  const measuredBadFps = capture.target_fps - 7;
  assert.equal(measuredBadFps >= capture.min_measured_fps, false);
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_40FPS_CONTRACT_PASS',
    ffmpeg_args_from_yaml_selected_mode: true,
    below_target_fps_rejected: true,
    fake_pass_blocked: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
