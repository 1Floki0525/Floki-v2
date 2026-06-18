'use strict';

const assert = require('node:assert/strict');

const cfg = require('../src/config/floki-config.cjs');

function run() {
  assert.equal(typeof cfg.getFlokiConfig, 'function');
  const oldCog = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'contract-public-api-cognition:4b';
  process.env.FLOKI_VISION_MODEL = 'contract-public-api-vision:4b';
  const chat = cfg.getFlokiConfig('chat');
  const game = cfg.getFlokiConfig('game');
  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');
  assert.equal(chat.models.cognition.model, 'contract-public-api-cognition:4b');
  assert.equal(chat.models.vision.model, 'contract-public-api-vision:4b');
  assert.equal(typeof chat.paths.media_root, 'string');
  assert.equal(typeof chat.paths.youtube_transcript_root, 'string');
  assert.equal(typeof chat.audio.whisper_model_size, 'string');
  assert.equal(typeof chat.audio.live_capture_seconds, 'number');
  assert.equal(typeof chat.sleep.timezone, 'string');
  assert.equal(typeof chat.dream.temperature, 'number');
  assert.equal(typeof chat.timeouts.ollama_http_ms, 'number');
  assert.equal(typeof chat.knowledge.autoload_enabled, 'boolean');
  assert.equal(typeof chat.live_chat.warm_cognition_on_start, 'boolean');
  assert.equal(typeof chat.life_clock.ticks_per_second, 'number');
  if (oldCog === undefined) delete process.env.FLOKI_COGNITION_MODEL; else process.env.FLOKI_COGNITION_MODEL = oldCog;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL; else process.env.FLOKI_VISION_MODEL = oldVision;
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CONFIG_PUBLIC_API_PASS',
    getFlokiConfig_exported: true,
    chat_mode_loaded: true,
    game_mode_loaded: true,
    env_override_verified: true,
    yaml_runtime_sections_available: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CONFIG_PUBLIC_API_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
