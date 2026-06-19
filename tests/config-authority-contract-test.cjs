'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../src/config/floki-config.cjs');

const REQUIRED_SECTIONS = ['models','modules','policies','vision','pineal_vision','embodiment','paths','sleep','dream','timeouts','knowledge','life_clock'];
const REQUIRED_EXPORTS = ['loadFlokiConfig','getModelConfig','getPathConfig','getSleepConfig','getDreamConfig','getAudioConfig','getTimeoutConfig','getKnowledgeConfig','getLiveChatConfig','getLifeClockConfig','getVisionConfig','getChatWorldVisionConfig','getGameWorldVisionConfig','getPinealVisionConfig','getFlokiConfig','resolveProjectPath','resolveStatePath','resolveToolPath','resolveExternalPath','clearConfigCache','configPathForMode'];

function run() {
  assert.ok(fs.existsSync(path.join(cfg.PROJECT_ROOT, 'config', 'chat.config.yaml')));
  assert.ok(fs.existsSync(path.join(cfg.PROJECT_ROOT, 'config', 'game.config.yaml')));
  for (const name of REQUIRED_EXPORTS) assert.equal(typeof cfg[name], 'function', name + ' must be exported');

  cfg.clearConfigCache();
  const chat = cfg.loadFlokiConfig('chat');
  cfg.clearConfigCache();
  const game = cfg.loadFlokiConfig('game');
  assert.notEqual(chat, game);
  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');
  assert.equal(chat.schema_version, 'floki-v2-core-brain-config-v1');
  assert.equal(game.schema_version, 'floki-v2-core-brain-config-v1');
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(chat[section], 'chat.' + section + ' is required');
    assert.ok(game[section], 'game.' + section + ' is required');
  }
  assert.ok(chat.chat_world_vision);
  assert.equal(Object.prototype.hasOwnProperty.call(chat, 'game_world_vision'), false);
  assert.ok(game.game_world_vision);
  assert.equal(Object.prototype.hasOwnProperty.call(game, 'chat_world_vision'), false);
  assert.ok(chat.audio);
  assert.ok(chat.live_chat);
  assert.equal(Object.prototype.hasOwnProperty.call(game, 'audio'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(game, 'live_chat'), false);

  const cognitionModel = chat.models.cognition.model;
  const visionModel = chat.models.vision.model;
  const oldCog = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'ignored-environment-selection';
  process.env.FLOKI_VISION_MODEL = 'ignored-environment-selection';
  cfg.clearConfigCache();
  const withEnvironment = cfg.loadFlokiConfig('chat');
  assert.equal(withEnvironment.models.cognition.model, cognitionModel);
  assert.equal(withEnvironment.models.vision.model, visionModel);
  if (oldCog === undefined) delete process.env.FLOKI_COGNITION_MODEL; else process.env.FLOKI_COGNITION_MODEL = oldCog;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL; else process.env.FLOKI_VISION_MODEL = oldVision;
  cfg.clearConfigCache();

  const models = cfg.getModelConfig('chat');
  assert.ok(models.cognition.model);
  assert.ok(models.vision.model);
  assert.equal(typeof cfg.getPathConfig('chat').state_root, 'string');
  assert.equal(typeof cfg.getSleepConfig('chat').timezone, 'string');
  assert.equal(typeof cfg.getDreamConfig('chat').temperature, 'number');
  assert.equal(typeof cfg.getAudioConfig('chat').mic_rate, 'number');
  assert.throws(() => cfg.getAudioConfig('game'), /chat-mode only/);
  assert.equal(typeof cfg.getTimeoutConfig('chat').ollama_http_ms, 'number');
  assert.equal(typeof cfg.getKnowledgeConfig('chat').autoload_enabled, 'boolean');
  assert.equal(typeof cfg.getLiveChatConfig('chat').warm_cognition_on_start, 'boolean');
  assert.throws(() => cfg.getLiveChatConfig('game'), /chat-mode only/);
  assert.equal(typeof cfg.getLifeClockConfig('chat').ticks_per_second, 'number');
  const vision = cfg.getVisionConfig('chat');
  assert.equal(vision.external_eyes_source, 'webcam');
  assert.equal(Object.prototype.hasOwnProperty.call(vision, 'vision_model_env'), false);
  assert.equal(cfg.getChatWorldVisionConfig('chat').used_as_game_world_eyes, false);
  assert.throws(() => cfg.getChatWorldVisionConfig('game'), /chat-mode only/);
  assert.equal(cfg.getGameWorldVisionConfig('game').enabled, false);
  assert.throws(() => cfg.getGameWorldVisionConfig('chat'), /game-mode only/);
  assert.equal(cfg.getPinealVisionConfig('chat').public_transcript_visible, false);
  assert.equal(cfg.getFlokiConfig('game').mode, 'game');

  console.log(JSON.stringify({ok:true,marker:'FLOKI_V2_CONFIG_AUTHORITY_PASS',chat_yaml_loads:true,game_yaml_loads:true,all_required_sections_present:true,environment_model_override_blocked:true,all_accessors_exported:true,chat_mode_only:true,game_mode_started:false}, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ok:false,marker:'FLOKI_V2_CONFIG_AUTHORITY_FAIL',error:error.message,chat_mode_only:true,game_mode_started:false}, null, 2)); process.exit(1); }
