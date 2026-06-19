'use strict';

const { webcamCaptureConfig } = require('./webcam-capabilities.cjs');

function webcamVisionStatus(mode) {
  const capture = webcamCaptureConfig(mode || 'chat');
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WEBCAM_VISION_STATUS_CONTRACT_PASS',
    mode: capture.mode,
    webcam_device_configured: true,
    requested_target_mode: {
      width: capture.target_width,
      height: capture.target_height,
      fps: capture.target_fps,
      pixel_format: capture.preferred_pixel_format
    },
    min_measured_fps: capture.min_measured_fps,
    ffmpeg_input_format: capture.ffmpeg_input_format,
    frame_transport: capture.frame_transport,
    raw_frame_storage_enabled: capture.raw_frame_storage_enabled,
    forty_fps_required_by_yaml: capture.min_measured_fps >= capture.target_fps,
    fake_green_status: false,
    chat_mode_only: capture.mode === 'chat',
    game_mode_started: false
  });
}

if (require.main === module) {
  console.log(JSON.stringify(webcamVisionStatus(process.argv[2] || 'chat'), null, 2));
}

module.exports = { webcamVisionStatus };
