'use strict';

const assert = require('node:assert/strict');

const {
  KNOWN_MODULES,
  MODULE_REGISTRY,
  loadCoreBrainConfig,
  normalizeModules,
  validateCoreBrainConfig,
  enabledModulesWithoutFactories,
  registeredModuleNames,
  unregisteredKnownModuleNames,
  createCoreBrain
} = require('../brain/core_brain/index.cjs');

function cloneConfig(config) {
  return {
    schema_version: config.schema_version,
    mode: config.mode,
    models: config.models,
    modules: Object.fromEntries(Object.entries(config.modules).map(([name, value]) => [name, { ...value }])),
    policies: { ...config.policies },
    source_path: config.source_path
  };
}

function run() {
  const chat = loadCoreBrainConfig('chat');

  assert.ok(KNOWN_MODULES.includes('chat_world_vision'));
  assert.ok(KNOWN_MODULES.includes('game_world_body'));

  assert.equal(Boolean(MODULE_REGISTRY.chat_world_vision), false);
  assert.equal(Boolean(MODULE_REGISTRY.game_world_body), false);
  assert.deepEqual(enabledModulesWithoutFactories(chat), []);

  assert.throws(() => {
    normalizeModules({
      thalamus: { enabled: true, required: true },
      fake_module: { enabled: true, required: false }
    });
  }, /unknown YAML module names: fake_module/);

  const badVision = cloneConfig(chat);
  badVision.modules.chat_world_vision.enabled = true;
  assert.deepEqual(enabledModulesWithoutFactories(badVision), ['chat_world_vision']);
  assert.throws(() => {
    validateCoreBrainConfig(badVision);
  }, /enabled modules without registered factories: chat_world_vision/);

  const badBody = cloneConfig(chat);
  badBody.modules.game_world_body.enabled = true;
  assert.deepEqual(enabledModulesWithoutFactories(badBody), ['game_world_body']);
  assert.throws(() => {
    validateCoreBrainConfig(badBody);
  }, /enabled modules without registered factories: game_world_body/);

  const core = createCoreBrain({
    mode: 'chat',
    session_id: 'core_brain_registry_contract_session',
    persist_diagnostics: false
  });

  assert.equal(core.getModule('chat_world_vision'), null);
  assert.equal(core.getModule('chat_world_hearing'), null);
  assert.equal(core.getModule('game_world_eyes'), null);
  assert.equal(core.getModule('game_world_body'), null);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_REGISTRY_HARDENING_PASS',
    registered_module_names: registeredModuleNames(),
    unregistered_known_module_names: unregisteredKnownModuleNames(),
    disabled_optional_modules_removable: true,
    enabled_without_factory_rejected: true,
    unknown_yaml_modules_rejected: true,
    core_brain_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
