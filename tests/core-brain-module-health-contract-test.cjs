'use strict';

const assert = require('node:assert/strict');

const {
  CHAT_REQUIRED_MODULES,
  createCoreBrain,
  registeredModuleNames
} = require('../brain/core_brain/index.cjs');

const {
  validateModuleContract
} = require('../src/brain/module-contract.cjs');

function assertNoPrivateReasoningMarkers(value, label) {
  const text = JSON.stringify(value).toLowerCase();

  for (const marker of [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ]) {
    assert.equal(text.includes(marker), false, label + ' contains banned marker: ' + marker);
  }
}

function assertRequiredBrainModuleHealthy(core, name) {
  const module = core.requireModule(name);

  assert.equal(module.module, name, name + ' module identity mismatch');
  assert.equal(typeof module.contract, 'object', name + ' must expose a module contract');

  validateModuleContract(module.contract);

  assert.equal(module.contract.module, name, name + ' contract module mismatch');
  assert.equal(module.contract.production, true, name + ' contract must be production=true');

  assertNoPrivateReasoningMarkers(module.contract, name + ' contract');

  return {
    module: name,
    contract_version: module.contract.contract_version,
    responsibility: module.contract.responsibility
  };
}

function run() {
  const core = createCoreBrain({
    mode: 'chat',
    session_id: 'core_brain_module_health_contract_session',
    persist_diagnostics: false
  });

  assert.equal(core.module, 'core_brain');
  assert.equal(core.mode, 'chat');
  assert.equal(core.config.source_path.endsWith('/config/chat.config.yaml'), true);

  const registered = registeredModuleNames();

  for (const enabledName of core.enabled_module_names) {
    assert.equal(
      registered.includes(enabledName),
      true,
      'enabled module missing registered factory: ' + enabledName
    );
  }

  const requiredHealth = CHAT_REQUIRED_MODULES.map((name) => {
    return assertRequiredBrainModuleHealthy(core, name);
  });

  const senses = core.getModule('chat_world_senses');
  assert.ok(senses, 'chat_world_senses should be enabled in chat config');
  assert.equal(senses.module, 'chat_world_senses');
  assert.equal(senses.kind, 'external_boundary');
  assert.equal(senses.scope, 'chat_world_only');

  assert.equal(core.getModule('chat_world_vision'), null);
  assert.equal(core.getModule('chat_world_hearing'), null);
  assert.equal(core.getModule('game_world_eyes'), null);
  assert.equal(core.getModule('game_world_body'), null);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_MODULE_HEALTH_PASS',
    mode: core.mode,
    config_path: core.config.source_path,
    enabled_modules: core.enabled_module_names,
    registered_modules: registered,
    required_brain_modules_healthy: requiredHealth,
    boundary_modules_healthy: [
      {
        module: senses.module,
        kind: senses.kind,
        scope: senses.scope
      }
    ],
    disabled_optional_modules_absent: [
      'chat_world_vision',
      'chat_world_hearing',
      'game_world_eyes',
      'game_world_body'
    ],
    core_brain_enabled_now: true,
    minecraft_enabled_now: false
  }, null, 2));
}

run();
