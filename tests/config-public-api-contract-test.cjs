'use strict';

const assert = require('node:assert/strict');
const cfg = require('../src/config/floki-config.cjs');

function run() {
  assert.equal(typeof cfg.getFlokiConfig, 'function');
  cfg.clearConfigCache();
  const baseline = cfg.getFlokiConfig('chat');
  const cognitionModel = baseline.models.cognition.model;
  const visionModel = baseline.models.vision.model;
  const oldCog = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'ignored-environment-selection';
  process.env.FLOKI_VISION_MODEL = 'ignored-environment-selection';
  cfg.clearConfigCache();
  const chat = cfg.getFlokiConfig('chat');
  const game = cfg.getFlokiConfig('game');
  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');
  assert.equal(chat.models.cognition.model, cognitionModel);
  assert.equal(chat.models.vision.model, visionModel);
  assert.equal(typeof chat.paths.media_root, 'string');
  assert.equal(typeof chat.audio.whisper_model_size, 'string');
  assert.equal(typeof chat.sleep.timezone, 'string');
  assert.equal(typeof chat.live_chat.warm_cognition_on_start, 'boolean');
  if (oldCog === undefined) delete process.env.FLOKI_COGNITION_MODEL; else process.env.FLOKI_COGNITION_MODEL = oldCog;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL; else process.env.FLOKI_VISION_MODEL = oldVision;
  cfg.clearConfigCache();
  console.log(JSON.stringify({ok:true,marker:'FLOKI_V2_CONFIG_PUBLIC_API_PASS',getFlokiConfig_exported:true,chat_mode_loaded:true,game_mode_loaded:true,yaml_model_authority_verified:true,chat_mode_only:true,game_mode_started:false}, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ok:false,marker:'FLOKI_V2_CONFIG_PUBLIC_API_FAIL',error:error.message,chat_mode_only:true,game_mode_started:false}, null, 2)); process.exit(1); }
