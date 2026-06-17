'use strict';

const assert = require('node:assert/strict');

const {
  loadCoreBrainConfig,
  validateCoreBrainConfig,
  normalizeModelSection
} = require('../brain/core_brain/index.cjs');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const old = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = old;
    } else {
      delete process.env[name];
    }
  }
}

function run() {
  const chat = loadCoreBrainConfig('chat');
  const game = loadCoreBrainConfig('game');

  validateCoreBrainConfig(chat);
  validateCoreBrainConfig(game);

  assert.equal(chat.models.cognition.model, process.env.FLOKI_COGNITION_MODEL || 'qwen3.5:9b');
  assert.equal(chat.models.vision.model, process.env.FLOKI_VISION_MODEL || 'qwen3-vl:4b');
  assert.equal(game.models.cognition.model, process.env.FLOKI_COGNITION_MODEL || 'qwen3.5:9b');
  assert.equal(game.models.vision.model, process.env.FLOKI_VISION_MODEL || 'qwen3-vl:4b');

  const customCognition = withEnv('FLOKI_COGNITION_MODEL', 'custom-cognition-model:local', () => {
    return normalizeModelSection({
      provider: 'ollama',
      model_env: 'FLOKI_COGNITION_MODEL',
      model_default: 'qwen3.5:9b',
      endpoint_env: 'FLOKI_COGNITION_ENDPOINT',
      endpoint_default: 'http://127.0.0.1:11434',
      temperature: 0.55,
      top_p: 0.9,
      timeout_ms: 120000,
      keep_alive: '24h'
    }, 'cognition');
  });

  assert.equal(customCognition.model, 'custom-cognition-model:local');

  const customVision = withEnv('FLOKI_VISION_MODEL', 'custom-vision-model:local', () => {
    return normalizeModelSection({
      provider: 'ollama',
      model_env: 'FLOKI_VISION_MODEL',
      model_default: 'qwen3-vl:4b',
      endpoint_env: 'FLOKI_VISION_ENDPOINT',
      endpoint_default: 'http://127.0.0.1:11435',
      enabled_now: false,
      mode_scope: 'chat_world_only',
      temperature: 0.2,
      top_p: 0.8,
      timeout_ms: 120000,
      keep_alive: '24h'
    }, 'vision');
  });

  assert.equal(customVision.model, 'custom-vision-model:local');

  assert.throws(() => {
    normalizeModelSection({
      provider: 'ollama',
      model_env: 'FLOKI_EMPTY_MODEL_FOR_TEST',
      model_default: '',
      endpoint_env: 'FLOKI_COGNITION_ENDPOINT',
      endpoint_default: 'http://127.0.0.1:11434'
    }, 'cognition');
  }, /cognition model must be non-empty/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CORE_BRAIN_YAML_MODEL_SOURCE_PASS',
    chat_config_cognition_model: chat.models.cognition.model,
    chat_config_vision_model: chat.models.vision.model,
    game_config_cognition_model: game.models.cognition.model,
    game_config_vision_model: game.models.vision.model,
    yaml_model_selection_source_of_truth: true,
    env_model_override_supported_by_normalizer: true,
    current_default_cognition_model: 'qwen3.5:9b',
    current_default_vision_model: 'qwen3-vl:4b',
    minecraft_enabled_now: false
  }, null, 2));
}

run();
