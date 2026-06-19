'use strict';

const assert = require('node:assert/strict');
const { webcamCaptureConfig } = require('../src/vision/webcam-capabilities.cjs');
const { buildFfmpegArgs, contractStatus, runLiveProof } = require('../src/vision/webcam-eyes-stream.cjs');

async function run() {
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
  const originalCaptureEnv = process.env.FLOKI_ALLOW_WEBCAM_CAPTURE;
  const originalVisionEnv = process.env.FLOKI_ALLOW_CHAT_VISION;
  process.env.FLOKI_ALLOW_WEBCAM_CAPTURE = '1';
  process.env.FLOKI_ALLOW_CHAT_VISION = '1';
  try {
    const liveStatus = await runLiveProof('chat', {
      probe_capabilities: () => Object.freeze({
        ok: false,
        marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_FAIL',
        exact_target_supported: false,
        supported_modes: [],
        capability_probe_run_now: true,
        chat_mode_only: true,
        game_mode_started: false
      }),
      measurement_runner: async (captureConfig, selectedMode) => Object.freeze({
        ok: true,
        measured_fps: captureConfig.min_measured_fps,
        frames_measured: captureConfig.measurement_frames,
        ffmpeg_exit_status: 0,
        ffmpeg_args_shape: ['-framerate', String(selectedMode.fps)]
      }),
      v4l2_status_runner: () => Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_WEBCAM_V4L2_RUNTIME_STATUS',
        nominal_fps: capture.target_fps,
        exposure_dynamic_framerate: { numeric_value: 0 },
        exposure_time_absolute: null,
        exposure_limited_fps_estimate: null
      })
    });
    assert.equal(liveStatus.ok, true);
    assert.equal(liveStatus.marker, 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_PASS');
    assert.equal(liveStatus.configured_mode_attempted, true);
    assert.equal(liveStatus.metadata_selection_failed, true);
    assert.equal(liveStatus.selected_mode.fps, capture.target_fps);

    const belowTargetLiveStatus = await runLiveProof('chat', {
      probe_capabilities: () => Object.freeze({
        ok: false,
        marker: 'FLOKI_V2_WEBCAM_CAPABILITIES_LIVE_FAIL',
        exact_target_supported: false,
        supported_modes: [],
        capability_probe_run_now: true,
        chat_mode_only: true,
        game_mode_started: false
      }),
      measurement_runner: async (captureConfig, selectedMode) => Object.freeze({
        ok: true,
        measured_fps: captureConfig.min_measured_fps - 1,
        frames_measured: captureConfig.measurement_frames,
        ffmpeg_exit_status: 0,
        ffmpeg_args_shape: ['-framerate', String(selectedMode.fps)],
        stderr_tail: 'captured from ' + captureConfig.device
      }),
      v4l2_status_runner: () => Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_WEBCAM_V4L2_RUNTIME_STATUS',
        nominal_fps: capture.target_fps,
        exposure_dynamic_framerate: { numeric_value: 0 },
        exposure_time_absolute: null,
        exposure_limited_fps_estimate: null
      })
    });
    assert.equal(belowTargetLiveStatus.ok, false);
    assert.equal(belowTargetLiveStatus.marker, 'FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL');
    assert.equal(belowTargetLiveStatus.configured_mode_attempted, true);
    assert.equal(belowTargetLiveStatus.metadata_selection_failed, true);
    assert.equal(belowTargetLiveStatus.ffmpeg_stderr_tail.includes(capture.device), false);
    assert.equal(belowTargetLiveStatus.ffmpeg_stderr_tail.includes('<webcam-device-from-yaml-or-env>'), true);
  } finally {
    if (originalCaptureEnv === undefined) delete process.env.FLOKI_ALLOW_WEBCAM_CAPTURE;
    else process.env.FLOKI_ALLOW_WEBCAM_CAPTURE = originalCaptureEnv;
    if (originalVisionEnv === undefined) delete process.env.FLOKI_ALLOW_CHAT_VISION;
    else process.env.FLOKI_ALLOW_CHAT_VISION = originalVisionEnv;
  }
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_40FPS_CONTRACT_PASS',
    ffmpeg_args_from_yaml_selected_mode: true,
    below_target_fps_rejected: true,
    live_below_target_fps_rejected_after_configured_attempt: true,
    live_proof_measures_configured_target_when_metadata_lacks_exact_mode: true,
    fake_pass_blocked: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_WEBCAM_40FPS_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
