'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  buildWebcamFfmpegArgs,
  measuredFps,
  runWebcamEyesStreamProof
} = require('../src/vision/webcam-eyes-stream.cjs');
const { getVisionConfig, getChatWorldVisionConfig } = require('../src/config/floki-config.cjs');

function allowedEnv() {
  const vision = getVisionConfig('chat');
  return {
    [vision.webcam_capture_allow_env]: '1',
    [vision.chat_vision_allow_env]: '1'
  };
}

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const vision = getVisionConfig('chat');
  const chatVision = getChatWorldVisionConfig('chat');
  const outputDir = path.join(os.tmpdir(), 'floki-webcam-contract');
  const plan = buildWebcamFfmpegArgs({ env: allowedEnv(), output_dir: outputDir });

  assert.equal(plan.target_fps, chatVision.target_fps);
  assert.equal(plan.target_fps, 40);
  assert.equal(plan.args.includes('screenshot'), false);
  assert.equal(plan.args.includes(plan.device), true);
  assert.equal(measuredFps(120, 3000), 40);

  const passing = runWebcamEyesStreamProof({
    env: allowedEnv(),
    output_dir: outputDir,
    command_ready: () => ({ ready: true, command: vision.webcam_capture_command, path: 'contract-command' }),
    capture_runner: () => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      elapsed_ms: 3000,
      frame_count: 120,
      latest_frame_file: path.join(outputDir, 'frame_000120.jpg')
    })
  });

  assert.equal(passing.ok, true);
  assert.equal(passing.marker, 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_PASS');
  assert.equal(passing.captured_frame_fps, 40);
  assert.equal(passing.vlm_inference_fps, null);
  assert.equal(passing.raw_frame_storage_enabled, false);
  assert.equal(passing.latest_frame_base64, null);
  assert.equal(passing.latest_frame_buffered, true);
  assert.equal(passing.latest_frame_base64_available, false);
  assert.equal(passing.desktop_automation_used_for_sight, false);
  assert.equal(passing.public_transcript_visible, false);

  const degraded = runWebcamEyesStreamProof({
    env: allowedEnv(),
    output_dir: outputDir,
    command_ready: () => ({ ready: true, command: vision.webcam_capture_command, path: 'contract-command' }),
    capture_runner: () => ({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      elapsed_ms: 3000,
      frame_count: 30,
      latest_frame_file: path.join(outputDir, 'frame_000030.jpg')
    })
  });

  assert.equal(degraded.ok, false);
  assert.equal(degraded.marker, 'FLOKI_V2_WEBCAM_EYES_STREAM_FAIL');
  assert.equal(degraded.captured_frame_fps < chatVision.target_fps, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_PASS',
    target_capture_fps_from_yaml: passing.target_capture_fps,
    captured_frame_fps: passing.captured_frame_fps,
    degraded_capture_is_not_pass: true,
    vlm_inference_fps_claimed_40: false,
    raw_frame_storage_enabled: false,
    desktop_automation_used_for_sight: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_WEBCAM_EYES_STREAM_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
