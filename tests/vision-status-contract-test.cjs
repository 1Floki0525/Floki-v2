'use strict';

const assert = require('node:assert/strict');

const { buildVisionStatus } = require('../src/vision/vision-status.cjs');
const { getVisionConfig } = require('../src/config/floki-config.cjs');

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const vision = getVisionConfig('chat');
  const envDevice = 'contract-status-camera';
  const status = buildVisionStatus({
    active_mode: 'chat',
    env: { [vision.webcam_device_env]: envDevice },
    webcam_status: { measured_fps: vision.target_capture_fps }
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_VISION_STATUS_PASS');
  assert.equal(status.active_mode, 'chat');
  assert.equal(status.current_external_eyes_source, 'webcam');
  assert.equal(status.webcam_enabled, true);
  assert.equal(status.webcam_configured_fps, 40);
  assert.equal(status.measured_webcam_fps, 40);
  assert.equal(status.webcam_device, envDevice);
  assert.equal(status.webcam_device_source, 'env');
  assert.equal(status.vision_model_env, vision.vision_model_env);
  assert.equal(status.vision_endpoint_env, vision.vision_endpoint_env);
  assert.equal(status.vlm_inference_enabled, true);
  assert.equal(status.vlm_inference_every_n_frames, vision.vlm_inference_every_n_frames);
  assert.equal(status.vlm_inference_min_interval_ms, vision.vlm_inference_min_interval_ms);
  assert.equal(status.pineal_mind_eye_enabled, true);
  assert.equal(status.game_vision_enabled, false);
  assert.equal(status.chat_mode_uses_webcam_eyes, true);
  assert.equal(status.game_mode_uses_first_person_game_view, true);
  assert.equal(status.pineal_mind_eye_used_for_dreams, true);
  assert.equal(status.webcam_used_as_game_world_eyes, false);
  assert.equal(status.desktop_automation_used_for_sight, false);
  assert.equal(status.mineflayer_used, false);

  const gameStatus = buildVisionStatus({ active_mode: 'game' });
  assert.equal(gameStatus.current_external_eyes_source, 'minecraft_first_person');
  assert.equal(gameStatus.webcam_enabled, false);
  assert.equal(gameStatus.game_vision_enabled, false);
  assert.equal(gameStatus.webcam_used_as_game_world_eyes, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VISION_STATUS_PASS',
    active_mode: status.active_mode,
    current_external_eyes_source: status.current_external_eyes_source,
    webcam_configured_fps: status.webcam_configured_fps,
    measured_webcam_fps: status.measured_webcam_fps,
    webcam_device: status.webcam_device,
    vision_model: status.vision_model,
    vision_endpoint: status.vision_endpoint,
    vlm_inference_enabled: status.vlm_inference_enabled,
    pineal_mind_eye_enabled: status.pineal_mind_eye_enabled,
    game_vision_enabled: status.game_vision_enabled,
    game_status_webcam_enabled: gameStatus.webcam_enabled,
    chat_mode_uses_webcam_eyes: true,
    game_mode_uses_first_person_game_view: true,
    pineal_mind_eye_used_for_dreams: true,
    webcam_used_as_game_world_eyes: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_VISION_STATUS_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
