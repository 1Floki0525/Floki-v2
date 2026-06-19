'use strict';

const assert = require('node:assert/strict');

const {
  CHAT_REQUIRED_MODULES,
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  enabledModuleNames,
  missingRequiredModules,
  createCoreBrain
} = require('../brain/core_brain/index.cjs');

function withoutEnv(name, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const old = process.env[name];
  delete process.env[name];
  try {
    return fn();
  } finally {
    if (had) process.env[name] = old;
  }
}

function run() {
  const chat = loadCoreBrainConfig('chat');
  const game = loadCoreBrainConfig('game');
  const yamlDefaultModels = withoutEnv('FLOKI_COGNITION_MODEL', () => {
    return Object.freeze({
      chat: loadCoreBrainConfig('chat').models.cognition.model,
      game: loadCoreBrainConfig('game').models.cognition.model
    });
  });

  validateCoreBrainConfig(chat);
  validateCoreBrainConfig(game);

  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');

  assert.ok(typeof chat.models.cognition.model === 'string' && chat.models.cognition.model.length > 0, 'chat cognition model must be a non-empty string from YAML');
  assert.ok(typeof game.models.cognition.model === 'string' && game.models.cognition.model.length > 0, 'game cognition model must be a non-empty string from YAML');
  assert.ok(typeof chat.models.vision.model === 'string' && chat.models.vision.model.length > 0, 'chat vision model must be a non-empty string from YAML');
  assert.ok(typeof game.models.vision.model === 'string' && game.models.vision.model.length > 0, 'game vision model must be a non-empty string from YAML');

  assert.notEqual(yamlDefaultModels.chat, yamlDefaultModels.game, 'chat and game YAML defaults should use different cognition models');

  assert.deepEqual(missingRequiredModules(chat), []);

  assert.equal(chat.modules.game_world_body.enabled, false);
  assert.equal(chat.modules.game_world_eyes.enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(chat.policies, 'usb_camera_as_game_world_eyes'), false);

  assert.equal(game.modules.chat_world_vision.enabled, false);
  assert.equal(game.modules.chat_world_hearing.enabled, false);
  assert.equal(game.policies.usb_camera_as_game_world_eyes, false);

  const core = createCoreBrain({
    mode: 'chat',
    session_id: 'core_brain_contract_session',
    persist_diagnostics: false
  });

  assert.equal(core.module, 'core_brain');
  assert.equal(core.mode, 'chat');
  assert.equal(core.config.source_path.endsWith('/config/chat.config.yaml'), true);

  const enabled = enabledModuleNames(chat.modules);
  const missingFromEnabled = CHAT_REQUIRED_MODULES.filter((name) => !enabled.includes(name));
  assert.deepEqual(missingFromEnabled, []);

  for (const name of CHAT_REQUIRED_MODULES) {
    assert.ok(core.requireModule(name), 'core_brain failed to instantiate required module: ' + name);
  }

  assert.equal(core.getModule('game_world_body'), null);
  assert.equal(core.getModule('game_world_eyes'), null);
  assert.equal(typeof core.handleChatText, 'function');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_CONFIG_CONTRACT_PASS',
    chat_config: chat.source_path,
    game_config: game.source_path,
    chat_required_modules: CHAT_REQUIRED_MODULES,
    chat_enabled_modules: enabled,
    chat_disabled_modules: core.disabled_module_names,
    registered_module_names: core.registered_module_names,
    unregistered_known_module_names: core.unregistered_known_module_names,
    game_enabled_modules: enabledModuleNames(game.modules),
    cognition_model_from_chat_yaml: chat.models.cognition.model,
    vision_model_from_chat_yaml: chat.models.vision.model,
    usb_camera_as_game_world_eyes: false,
    core_brain_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
