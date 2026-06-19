'use strict';

const {
  loadFlokiConfig,
  getModelConfig,
  getVisionConfig,
  getChatWorldVisionConfig,
  getGameWorldVisionConfig,
  getPinealVisionConfig
} = require('../config/floki-config.cjs');
const { resolveWebcamDevice } = require('./webcam-eyes-stream.cjs');
const { resolveVisionSource } = require('./vision-source-router.cjs');

function buildVisionStatus(options = {}) {
  const activeMode = options.active_mode || 'chat';
  const configMode = activeMode === 'game' ? 'game' : 'chat';
  const config = loadFlokiConfig(configMode);
  const models = getModelConfig(configMode);
  const vision = getVisionConfig(configMode);
  const chatVision = configMode === 'chat' ? getChatWorldVisionConfig(configMode) : null;
  const gameVision = configMode === 'game' ? getGameWorldVisionConfig(configMode) : null;
  const pinealVision = getPinealVisionConfig(configMode);
  const policies = config.policies || {};
  const device = configMode === 'chat'
    ? resolveWebcamDevice({ env: options.env || process.env, mode: configMode })
    : Object.freeze({ device: null, source: null, env_key: null });
  const route = resolveVisionSource({ mode: activeMode, config_mode: configMode });
  const measured = options.webcam_status || {};
  const webcamEnabled = configMode === 'chat' &&
    chatVision &&
    chatVision.enabled === true &&
    policies.chat_world_vision_enabled_now === true;

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_VISION_STATUS_PASS',
    config_path: config.source_path,
    active_mode: activeMode,
    current_external_eyes_source: route.external_world_observation ? route.current_source : null,
    current_vision_source: route.current_source,
    webcam_enabled: webcamEnabled,
    webcam_configured_fps: chatVision ? chatVision.target_fps : null,
    measured_webcam_fps: typeof measured.measured_fps === 'number' ? measured.measured_fps : null,
    webcam_device: device.device,
    webcam_device_source: device.source,
    webcam_device_env: device.env_key,
    vision_model: models.vision.model,
    vision_endpoint: models.vision.endpoint,
    vision_model_source: 'config_yaml',
    vlm_inference_enabled: vision.vlm_inference_enabled,
    vlm_inference_every_n_frames: vision.vlm_inference_every_n_frames,
    vlm_inference_min_interval_ms: vision.vlm_inference_min_interval_ms,
    pineal_mind_eye_enabled: pinealVision.enabled,
    game_vision_enabled: gameVision ? gameVision.enabled : false,
    external_eyes_enabled: vision.external_eyes_enabled,
    chat_mode_uses_webcam_eyes: route.chat_mode_uses_webcam_eyes,
    game_mode_uses_first_person_game_view: route.game_mode_uses_first_person_game_view,
    pineal_mind_eye_used_for_dreams: route.pineal_mind_eye_used_for_dreams,
    webcam_used_as_game_world_eyes: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    public_frame_logging_enabled: vision.public_frame_logging_enabled,
    raw_frame_storage_enabled: vision.raw_frame_storage_enabled,
    public_transcript_visible: false,
    chat_mode_only: activeMode !== 'game',
    game_mode_started: false
  });
}

function printVisionStatus() {
  const status = buildVisionStatus();
  console.log(JSON.stringify(status, null, 2));
  return status;
}

module.exports = {
  buildVisionStatus,
  printVisionStatus
};

if (require.main === module) {
  printVisionStatus();
}
