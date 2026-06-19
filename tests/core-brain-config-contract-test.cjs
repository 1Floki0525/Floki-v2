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

function resolvedYamlValue(section, envKeyName, defaultKeyName) {
  assert.ok(section && typeof section === 'object', 'model section must exist');

  const envName = section[envKeyName];
  const yamlDefault = section[defaultKeyName];

  assertNonEmptyString(yamlDefault, defaultKeyName);

  if (
    typeof envName === 'string' &&
    envName.trim() &&
    typeof process.env[envName] === 'string' &&
    process.env[envName].trim()
  ) {
    return process.env[envName].trim();
  }

  return yamlDefault.trim();
}

function run() {
  const chat = loadCoreBrainConfig('chat');
  const game = loadCoreBrainConfig('game');

  const chatYaml = loadYamlFile(chat.source_path);
  const gameYaml = loadYamlFile(game.source_path);

  validateCoreBrainConfig(chat);
  validateCoreBrainConfig(game);

  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');

  assertNonEmptyString(
    chat.models.cognition.model,
    'chat cognition model'
  );
  assertNonEmptyString(
    game.models.cognition.model,
    'game cognition model'
  );
  assertNonEmptyString(
    chat.models.vision.model,
    'chat vision model'
  );
  assertNonEmptyString(
    game.models.vision.model,
    'game vision model'
  );

  /*
   * There is deliberately no equality or inequality rule here.
   *
   * Chat and game may use:
   * - the same cognition model,
   * - different cognition models,
   * - the same vision model,
   * - different vision models.
   *
   * The YAML files are independently authoritative. Optional environment
   * overrides are honored only when the YAML names an override variable.
   */
  const expectedChatCognition = resolvedYamlValue(
    chatYaml.models.cognition,
    'model_env',
    'model_default'
  );
  const expectedGameCognition = resolvedYamlValue(
    gameYaml.models.cognition,
    'model_env',
    'model_default'
  );
  const expectedChatVision = resolvedYamlValue(
    chatYaml.models.vision,
    'model_env',
    'model_default'
  );
  const expectedGameVision = resolvedYamlValue(
    gameYaml.models.vision,
    'model_env',
    'model_default'
  );

  assert.equal(
    chat.models.cognition.model,
    expectedChatCognition,
    'chat cognition runtime must resolve from chat YAML or its named environment override'
  );
  assert.equal(
    game.models.cognition.model,
    expectedGameCognition,
    'game cognition runtime must resolve from game YAML or its named environment override'
  );
  assert.equal(
    chat.models.vision.model,
    expectedChatVision,
    'chat vision runtime must resolve from chat YAML or its named environment override'
  );
  assert.equal(
    game.models.vision.model,
    expectedGameVision,
    'game vision runtime must resolve from game YAML or its named environment override'
  );

  assert.deepEqual(missingRequiredModules(chat), []);

  assert.equal(chat.modules.game_world_body.enabled, false);
  assert.equal(chat.modules.game_world_eyes.enabled, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      chat.policies,
      'usb_camera_as_game_world_eyes'
    ),
    false
  );

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
  assert.equal(
    core.config.source_path.endsWith('/config/chat.config.yaml'),
    true
  );

  const enabled = enabledModuleNames(chat.modules);
  const missingFromEnabled = CHAT_REQUIRED_MODULES.filter(
    (name) => !enabled.includes(name)
  );

  assert.deepEqual(missingFromEnabled, []);

  for (const name of CHAT_REQUIRED_MODULES) {
    assert.ok(
      core.requireModule(name),
      'core_brain failed to instantiate required module: ' + name
    );
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
    environment_override_supported_when_named_by_yaml: true,
    usb_camera_as_game_world_eyes: false,
    core_brain_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
