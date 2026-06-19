'use strict';

const assert = require('node:assert/strict');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');

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
  const chatRaw = loadYamlFile(chatConfig.source_path);
  const gameRaw = loadYamlFile(gameConfig.source_path);

  validateCoreBrainConfig(chatConfig);
  validateCoreBrainConfig(gameConfig);

  const chatEnabled = enabledModuleNames(chatConfig.modules);
  const gameEnabled = enabledModuleNames(gameConfig.modules);

  assert.equal(chatConfig.mode, 'chat');
  assert.equal(gameConfig.mode, 'game');

  assert.ok(typeof chatConfig.models.cognition.model === 'string' && chatConfig.models.cognition.model.length > 0, 'chat cognition model must be a non-empty string from YAML');
  assert.ok(typeof gameConfig.models.cognition.model === 'string' && gameConfig.models.cognition.model.length > 0, 'game cognition model must be a non-empty string from YAML');
  assert.ok(typeof chatConfig.models.vision.model === 'string' && chatConfig.models.vision.model.length > 0, 'chat vision model must be a non-empty string from YAML');
  assert.ok(typeof gameConfig.models.vision.model === 'string' && gameConfig.models.vision.model.length > 0, 'game vision model must be a non-empty string from YAML');
  assert.notEqual(chatConfig.models.cognition.model, gameConfig.models.cognition.model, 'chat and game should have different cognition models from YAML');

  assert.equal(chatConfig.models.vision.mode_scope, 'chat_world_only');
  assert.equal(gameConfig.models.vision.mode_scope, 'game_world_first_person_only');

  assertModuleEnabled(chatConfig, 'chat_world_senses', true);
  assertModuleEnabled(gameConfig, 'game_world_eyes', false);
  assertModuleEnabled(gameConfig, 'game_world_body', false);

  assert.equal(Object.prototype.hasOwnProperty.call(chatRaw.modules, 'game_world_eyes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(chatRaw.modules, 'game_world_body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(gameRaw.modules, 'chat_world_senses'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(gameRaw.modules, 'chat_world_vision'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(gameRaw.modules, 'chat_world_hearing'), false);

  assert.equal(Object.prototype.hasOwnProperty.call(chatConfig.policies, 'usb_camera_as_game_world_eyes'), false);
  assertPolicy(gameConfig, 'usb_camera_as_game_world_eyes', false);

  assertPolicy(chatConfig, 'chat_world_camera_detection_enabled_now', true);
  assert.equal(Object.prototype.hasOwnProperty.call(gameConfig.policies, 'chat_world_camera_detection_enabled_now'), false);

  assert.equal(Object.prototype.hasOwnProperty.call(chatConfig.policies, 'game_world_eyes_enabled_now'), false);
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
