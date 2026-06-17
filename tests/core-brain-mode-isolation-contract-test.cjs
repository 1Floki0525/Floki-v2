'use strict';

const assert = require('node:assert/strict');

const {
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  enabledModuleNames,
  createCoreBrain
} = require('../brain/core_brain/index.cjs');

function assertModuleEnabled(config, name, expected) {
  assert.equal(
    config.modules[name].enabled,
    expected,
    config.mode + ' module ' + name + ' enabled state mismatch'
  );
}

function assertPolicy(config, name, expected) {
  assert.equal(
    config.policies[name],
    expected,
    config.mode + ' policy ' + name + ' mismatch'
  );
}

function run() {
  const chatConfig = loadCoreBrainConfig('chat');
  const gameConfig = loadCoreBrainConfig('game');

  validateCoreBrainConfig(chatConfig);
  validateCoreBrainConfig(gameConfig);

  const chatEnabled = enabledModuleNames(chatConfig.modules);
  const gameEnabled = enabledModuleNames(gameConfig.modules);

  assert.equal(chatConfig.mode, 'chat');
  assert.equal(gameConfig.mode, 'game');

  assert.equal(chatConfig.models.cognition.model, 'qwen3.5:9b');
  assert.equal(gameConfig.models.cognition.model, 'qwen3.5:9b');
  assert.equal(chatConfig.models.vision.model, 'qwen3-vl:4b');
  assert.equal(gameConfig.models.vision.model, 'qwen3-vl:4b');

  assert.equal(chatConfig.models.vision.mode_scope, 'chat_world_only');
  assert.equal(gameConfig.models.vision.mode_scope, 'game_world_first_person_only');

  assertModuleEnabled(chatConfig, 'chat_world_senses', true);
  assertModuleEnabled(chatConfig, 'chat_world_vision', false);
  assertModuleEnabled(chatConfig, 'chat_world_hearing', false);
  assertModuleEnabled(chatConfig, 'game_world_eyes', false);
  assertModuleEnabled(chatConfig, 'game_world_body', false);

  assertModuleEnabled(gameConfig, 'chat_world_senses', false);
  assertModuleEnabled(gameConfig, 'chat_world_vision', false);
  assertModuleEnabled(gameConfig, 'chat_world_hearing', false);
  assertModuleEnabled(gameConfig, 'game_world_eyes', false);
  assertModuleEnabled(gameConfig, 'game_world_body', false);

  assertPolicy(chatConfig, 'usb_camera_as_game_world_eyes', false);
  assertPolicy(gameConfig, 'usb_camera_as_game_world_eyes', false);

  assertPolicy(chatConfig, 'chat_world_camera_detection_enabled_now', true);
  assertPolicy(gameConfig, 'chat_world_camera_detection_enabled_now', false);

  assertPolicy(chatConfig, 'game_world_eyes_enabled_now', false);
  assertPolicy(gameConfig, 'game_world_eyes_enabled_now', false);

  const chatCore = createCoreBrain({
    mode: 'chat',
    session_id: 'mode_isolation_chat_session',
    persist_diagnostics: false
  });

  const gameCore = createCoreBrain({
    mode: 'game',
    session_id: 'mode_isolation_game_session',
    persist_diagnostics: false
  });

  assert.equal(chatCore.mode, 'chat');
  assert.equal(gameCore.mode, 'game');

  assert.ok(chatCore.getModule('chat_world_senses'));
  assert.equal(gameCore.getModule('chat_world_senses'), null);

  assert.equal(chatCore.getModule('game_world_eyes'), null);
  assert.equal(chatCore.getModule('game_world_body'), null);
  assert.equal(gameCore.getModule('game_world_eyes'), null);
  assert.equal(gameCore.getModule('game_world_body'), null);

  assert.equal(chatEnabled.includes('chat_world_senses'), true);
  assert.equal(gameEnabled.includes('chat_world_senses'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_MODE_ISOLATION_PASS',
    chat_config: chatConfig.source_path,
    game_config: gameConfig.source_path,
    chat_enabled_modules: chatEnabled,
    game_enabled_modules: gameEnabled,
    maker_realm_eyes_source: 'usb_webcam',
    maker_realm_ears_source: 'microphone',
    maker_realm_voice_source: 'speakers',
    minecraft_home_realm_eyes_source: 'minecraft_first_person_view',
    minecraft_home_realm_voice_source: 'minecraft_chat_interface',
    webcam_scope_in_chat_mode: 'maker_realm_chat_eyes',
    webcam_scope_in_game_mode: 'not_game_eyes',
    minecraft_first_person_view_scope: 'game_realm_eyes',
    chat_world_senses_loaded_in_chat: true,
    chat_world_senses_loaded_in_game: false,
    game_world_body_loaded_in_chat: false,
    game_world_body_loaded_in_game: false,
    usb_camera_as_game_world_eyes: false,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
