'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROJECT_ROOT,
  loadFlokiConfig,
  clearConfigCache,
  getChatWorldVisionConfig,
  getGameWorldVisionConfig
} = require('../src/config/floki-config.cjs');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const { resolveVisionSource } = require('../src/vision/vision-source-router.cjs');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function yamlModel(section, label) {
  assert.ok(section && typeof section === 'object', label + ' YAML section must exist');
  assert.equal(hasOwn(section, 'model_env'), false, label + ' must not declare model_env');
  assert.equal(hasOwn(section, 'model_default'), false, label + ' must not declare model_default');
  assert.equal(typeof section.model, 'string', label + '.model must be a string');
  assert.ok(section.model.trim().length > 0, label + '.model must be non-empty');
  return section.model.trim();
}

function withIgnoredModelEnvironment(fn) {
  const names = ['FLOKI_COGNITION_MODEL', 'FLOKI_VISION_MODEL'];
  const previous = new Map();
  for (const name of names) {
    previous.set(name, Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : undefined);
    process.env[name] = 'environment-model-selection-must-be-ignored';
  }
  try {
    clearConfigCache();
    return fn();
  } finally {
    for (const name of names) {
      const old = previous.get(name);
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
    clearConfigCache();
  }
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  const chatYamlPath = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
  const gameYamlPath = path.join(PROJECT_ROOT, 'config', 'game.config.yaml');
  const chatRaw = loadYamlFile(chatYamlPath);
  const gameRaw = loadYamlFile(gameYamlPath);
  const loaded = withIgnoredModelEnvironment(() => ({
    chat: loadFlokiConfig('chat'),
    game: loadFlokiConfig('game')
  }));
  const chat = loaded.chat;
  const game = loaded.game;

  assert.equal(hasOwn(chatRaw, 'chat_world_vision'), true);
  assert.equal(hasOwn(chatRaw, 'game_world_vision'), false);
  assert.equal(hasOwn(gameRaw, 'game_world_vision'), true);
  assert.equal(hasOwn(gameRaw, 'chat_world_vision'), false);

  assert.equal(hasOwn(chat.modules, 'game_world_eyes'), false);
  assert.equal(hasOwn(chat.modules, 'game_world_body'), false);
  assert.equal(hasOwn(game.modules, 'chat_world_senses'), false);
  assert.equal(hasOwn(game.modules, 'chat_world_vision'), false);
  assert.equal(hasOwn(game.modules, 'chat_world_hearing'), false);

  for (const key of ['minecraft_enabled_now', 'body_enabled_now', 'game_world_eyes_enabled_now', 'usb_camera_as_game_world_eyes']) {
    assert.equal(hasOwn(chat.policies, key), false, 'chat policies must not contain ' + key);
  }
  for (const key of ['chat_world_camera_detection_enabled_now', 'chat_world_vision_enabled_now']) {
    assert.equal(hasOwn(game.policies, key), false, 'game policies must not contain ' + key);
  }

  assert.equal(chat.vision.external_eyes_source, 'webcam');
  assert.equal(game.vision.external_eyes_source, 'minecraft_first_person');
  assert.equal(hasOwn(chat.vision, 'game_external_eyes_source'), false);
  assert.equal(hasOwn(game.vision, 'chat_external_eyes_source'), false);

  assert.equal(chat.models.cognition.model, yamlModel(chatRaw.models.cognition, 'chat cognition'));
  assert.equal(game.models.cognition.model, yamlModel(gameRaw.models.cognition, 'game cognition'));
  assert.equal(chat.models.vision.model, yamlModel(chatRaw.models.vision, 'chat vision'));
  assert.equal(game.models.vision.model, yamlModel(gameRaw.models.vision, 'game vision'));

  assert.equal(hasOwn(chat, 'game_world_vision'), false);
  assert.equal(hasOwn(game, 'chat_world_vision'), false);
  assert.throws(() => getChatWorldVisionConfig('game'), /chat-mode only/);
  assert.throws(() => getGameWorldVisionConfig('chat'), /game-mode only/);

  const chatRoute = resolveVisionSource({ mode: 'chat' });
  const gameRoute = resolveVisionSource({ mode: 'game' });
  assert.equal(chatRoute.current_source, 'webcam');
  assert.equal(gameRoute.current_source, 'minecraft_first_person');

  const routerSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'vision', 'vision-source-router.cjs'), 'utf8');
  assert.equal(routerSource.includes('getChatWorldVisionConfig(configMode),\n    game_world_vision'), false);
  assert.equal(routerSource.includes('getGameWorldVisionConfig(configMode),\n    pineal_vision'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_STRICT_MODE_CONFIG_ISOLATION_PASS',
    cognition_model_relationship_restricted: false,
    vision_model_relationship_restricted: false,
    model_names_hardcoded_by_contract: false,
    environment_model_override_blocked: true,
    chat_has_chat_world_vision: true,
    chat_has_game_world_vision: false,
    game_has_game_world_vision: true,
    game_has_chat_world_vision: false,
    inactive_accessors_throw: true,
    chat_cognition_model: chat.models.cognition.model,
    chat_vision_model: chat.models.vision.model,
    chat_vision_source: chat.vision.external_eyes_source,
    game_vision_source: game.vision.external_eyes_source,
    routers_active_mode_only: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_STRICT_MODE_CONFIG_ISOLATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
