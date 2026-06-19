'use strict';

const assert = require('node:assert/strict');

const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const {
  CHAT_REQUIRED_MODULES,
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  enabledModuleNames,
  missingRequiredModules,
  createCoreBrain
} = require('../brain/core_brain/index.cjs');

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', label + ' must be a string');
  assert.ok(value.trim().length > 0, label + ' must be non-empty');
}

function yamlModel(section, label) {
  assert.ok(section && typeof section === 'object', label + ' YAML section must exist');
  assert.equal(Object.prototype.hasOwnProperty.call(section, 'model_env'), false, label + ' must not declare model_env');
  assert.equal(Object.prototype.hasOwnProperty.call(section, 'model_default'), false, label + ' must not declare model_default');
  assertNonEmptyString(section.model, label + '.model');
  return section.model.trim();
}

function withIgnoredModelEnvironment(fn) {
  const oldCognition = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'environment-model-selection-must-be-ignored';
  process.env.FLOKI_VISION_MODEL = 'environment-model-selection-must-be-ignored';
  try {
    return fn();
  } finally {
    if (oldCognition === undefined) delete process.env.FLOKI_COGNITION_MODEL;
    else process.env.FLOKI_COGNITION_MODEL = oldCognition;
    if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL;
    else process.env.FLOKI_VISION_MODEL = oldVision;
  }
}

function run() {
  const loaded = withIgnoredModelEnvironment(() => ({
    chat: loadCoreBrainConfig('chat'),
    game: loadCoreBrainConfig('game')
  }));
  const chat = loaded.chat;
  const game = loaded.game;

  const chatYaml = loadYamlFile(chat.source_path);
  const gameYaml = loadYamlFile(game.source_path);

  validateCoreBrainConfig(chat);
  validateCoreBrainConfig(game);

  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');

  assertNonEmptyString(chat.models.cognition.model, 'chat cognition model');
  assertNonEmptyString(game.models.cognition.model, 'game cognition model');
  assertNonEmptyString(chat.models.vision.model, 'chat vision model');
  assertNonEmptyString(game.models.vision.model, 'game vision model');

  assert.equal(chat.models.cognition.model, yamlModel(chatYaml.models.cognition, 'chat cognition'));
  assert.equal(game.models.cognition.model, yamlModel(gameYaml.models.cognition, 'game cognition'));
  assert.equal(chat.models.vision.model, yamlModel(chatYaml.models.vision, 'chat vision'));
  assert.equal(game.models.vision.model, yamlModel(gameYaml.models.vision, 'game vision'));

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
    cognition_model_runtime_chat: chat.models.cognition.model,
    cognition_model_runtime_game: game.models.cognition.model,
    cognition_models_may_match: true,
    cognition_models_may_differ: true,
    vision_model_runtime_chat: chat.models.vision.model,
    vision_model_runtime_game: game.models.vision.model,
    model_names_hardcoded_by_contract: false,
    yaml_model_selection_authoritative: true,
    environment_model_override_blocked: true,
    usb_camera_as_game_world_eyes: false,
    core_brain_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
