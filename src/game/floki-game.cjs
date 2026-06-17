'use strict';

/**
 * Floki-v2 game entrypoint.
 *
 * Game mode is future Minecraft incarnation.
 *
 * Current stage:
 * - loads config/game.config.yaml through core_brain
 * - proves game mode is guarded
 * - does not start Minecraft
 * - does not fake body movement
 * - does not fake game-world eyes
 * - does not use USB camera as game eyes
 */

const {
  createCoreBrain,
  loadCoreBrainConfig,
  enabledModuleNames,
  registeredModuleNames
} = require('../../brain/core_brain/index.cjs');

function createGameCore(options = {}) {
  return createCoreBrain({
    mode: 'game',
    smoke: options.smoke === true,
    session_id: options.session_id,
    diagnostics_path: options.diagnostics_path,
    persist_diagnostics: false
  });
}

function makeStatus() {
  const config = loadCoreBrainConfig('game');
  const core = createGameCore({
    session_id: 'game_status_session',
    persist_diagnostics: false
  });

  const enabledModules = enabledModuleNames(config.modules);

  return {
    ok: true,
    marker: 'FLOKI_V2_GAME_MODE_CORE_BRAIN_GUARDED',
    command: 'floki-start.sh game',
    mode: 'game',
    stage: 'guarded_not_wired_yet',
    config_path: config.source_path,
    core_brain_enabled_now: true,
    enabled_modules: enabledModules,
    registered_modules: registeredModuleNames(),
    core_enabled_modules: core.enabled_module_names,
    cognition_model: config.models.cognition.model,
    vision_model: config.models.vision.model,
    vision_mode_scope: config.models.vision.mode_scope,
    minecraft_home_realm_eyes_source: 'minecraft_first_person_view',
    minecraft_home_realm_body_source: 'minecraft_player_avatar',
    minecraft_home_realm_voice_source: 'minecraft_chat_interface',
    maker_realm_eyes_source: 'not_loaded_in_game',
    maker_realm_ears_source: 'not_loaded_in_game',
    maker_realm_voice_source: 'not_loaded_in_game',
    webcam_scope: 'not_game_eyes',
    microphone_scope: 'not_game_ears',
    speaker_scope: 'not_game_voice',
    minecraft_first_person_view_scope: 'game_realm_eyes',
    usb_camera_as_game_world_eyes: config.policies.usb_camera_as_game_world_eyes,
    cognition_available_for_game_now: true,
    vision_enabled_now: false,
    minecraft_enabled_now: false,
    papermc_enabled_now: false,
    bridge_enabled_now: false,
    body_movement_enabled_now: false,
    game_world_eyes_enabled_now: false,
    allowed_now: false,
    reason: 'Minecraft game mode is reserved for the future body/eyes/bridge stage. It now loads core_brain with config/game.config.yaml, but remains guarded.',
    future_requirements: [
      'PaperMC lifecycle scripts',
      'Minecraft client/bridge process',
      'Minecraft first-person frame source',
      'game_world_eyes module factory',
      'game_world_body module factory',
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
    core_brain_enabled_now: status.core_brain_enabled_now,
    config_path: status.config_path,
    enabled_modules: status.enabled_modules,
    cognition_model: status.cognition_model,
    vision_model: status.vision_model,
    vision_mode_scope: status.vision_mode_scope,
    minecraft_home_realm_eyes_source: status.minecraft_home_realm_eyes_source,
    minecraft_home_realm_body_source: status.minecraft_home_realm_body_source,
    minecraft_home_realm_voice_source: status.minecraft_home_realm_voice_source,
    maker_realm_eyes_source: status.maker_realm_eyes_source,
    maker_realm_ears_source: status.maker_realm_ears_source,
    maker_realm_voice_source: status.maker_realm_voice_source,
    webcam_scope: status.webcam_scope,
    microphone_scope: status.microphone_scope,
    speaker_scope: status.speaker_scope,
    minecraft_first_person_view_scope: status.minecraft_first_person_view_scope,
    usb_camera_as_game_world_eyes: status.usb_camera_as_game_world_eyes,
    minecraft_enabled_now: status.minecraft_enabled_now,
    body_movement_enabled_now: status.body_movement_enabled_now,
    game_world_eyes_enabled_now: status.game_world_eyes_enabled_now
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

module.exports = {
  createGameCore,
  makeStatus,
  runSmoke
};

if (require.main === module) {
  main();
}
