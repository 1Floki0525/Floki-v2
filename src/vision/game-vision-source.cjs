'use strict';

const {
  loadFlokiConfig,
  getVisionConfig,
  getGameWorldVisionConfig
} = require('../config/floki-config.cjs');

function buildGameVisionSourceStatus(options = {}) {
  const config = loadFlokiConfig('game');
  const vision = getVisionConfig('game');
  const gameVision = getGameWorldVisionConfig('game');
  const gameModeStarted = options.game_mode_started === true;
  const enabledNow = gameVision.enabled === true && gameModeStarted;

  if (gameVision.source !== vision.external_eyes_source) {
    throw new Error('game_world_vision.source must match vision.external_eyes_source');
  }
  if (gameVision.source !== 'minecraft_first_person') {
    throw new Error('game vision source must be minecraft_first_person');
  }

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_GAME_VISION_SOURCE_CONTRACT_PASS',
    config_path: config.source_path,
    source: gameVision.source,
    sight_scope: gameVision.sight_scope,
    target_fps: gameVision.target_fps,
    enabled_by_yaml: gameVision.enabled,
    enabled_now: enabledNow,
    starts_only_with_game_mode: gameVision.starts_only_with_game_mode,
    game_mode_started: gameModeStarted,
    minecraft_started_now: false,
    papermc_started_now: false,
    webcam_used: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    pathfinding_used: false,
    rcon_body_control_used: false,
    chat_world_webcam_eyes_used: false,
    external_world_observation: enabledNow,
    internal_reality: false,
    public_transcript_visible: false,
    spoken_aloud: false
  });
}

module.exports = {
  buildGameVisionSourceStatus
};

if (require.main === module) {
  try {
    console.log(JSON.stringify(buildGameVisionSourceStatus(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_GAME_VISION_SOURCE_CONTRACT_FAIL',
      error: error.message,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}
