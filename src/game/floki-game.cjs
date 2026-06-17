'use strict';

/**
 * Floki-v2 game entrypoint.
 *
 * This is the stable launcher target for future Minecraft mode:
 *
 *   bin/floki-start.sh game
 *
 * Current stage is guarded. It must not fake:
 * - Minecraft bridge
 * - body control
 * - in-game eyes
 * - PaperMC connection
 */

const models = require('../config/model-config.cjs');
const runtime = require('../config/runtime-config.cjs');

function makeStatus() {
  const modelConfig = models.getModelConfig ? models.getModelConfig() : models.MODEL_CONFIG || models;

  if (typeof models.validateModelConfig === "function") {
    models.validateModelConfig(modelConfig);
  }

  return {
    ok: true,
    marker: 'FLOKI_V2_GAME_MODE_GUARDED',
    command: 'floki-start.sh game',
    mode: 'game',
    stage: 'not_wired_yet',
    cognition_model: modelConfig.cognition.model,
    vision_model: modelConfig.vision.model,
    cognition_enabled_now: modelConfig.cognition.enabled_in_current_stage,
    vision_enabled_now: modelConfig.vision.enabled_in_current_stage,
    minecraft_enabled_now: false,
    papermc_enabled_now: false,
    bridge_enabled_now: false,
    body_movement_enabled_now: false,
    in_game_eyes_enabled_now: false,
    allowed_now: false,
    reason: 'Minecraft game mode is reserved for the future body/eyes/bridge stage. It exists now so the launcher contract is stable.',
    future_requirements: [
      'PaperMC lifecycle scripts',
      'Minecraft client/bridge process',
      'in-game vision source',
      'body action router',
      'motor safety guard',
      'live proof tests'
    ]
  };
}

function runSmoke() {
  const status = makeStatus();
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_GAME_ENTRYPOINT_CONTRACT_PASS',
    game_command_exists: true,
    game_mode_guarded_now: true,
    minecraft_enabled_now: status.minecraft_enabled_now,
    body_movement_enabled_now: status.body_movement_enabled_now,
    in_game_eyes_enabled_now: status.in_game_eyes_enabled_now
  }, null, 2));
}

function runGame() {
  const status = makeStatus();
  console.log(JSON.stringify(status, null, 2));
  process.exit(2);
}

function main() {
  if (process.argv.includes('--smoke')) {
    runSmoke();
    return;
  }

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(makeStatus(), null, 2));
    return;
  }

  runGame();
}

main();
