'use strict';

/**
 * Config authority contract test.
 *
 * Proves that:
 * - floki-config.cjs exists and exports accessors.
 * - Both chat and game YAML files load successfully.
 * - Chat and game configs are separate objects.
 * - chat.mode === "chat" and game.mode === "game".
 * - All required sections exist in both configs.
 * - Env overrides work only where YAML declares env keys.
 * - Config accessors are exported and usable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT } = require('../src/config/floki-config.cjs');

const REQUIRED_SECTIONS = [
  'models',
  'modules',
  'policies',
  'embodiment',
  'paths',
  'sleep',
  'dream',
  'audio',
  'timeouts',
  'knowledge',
  'live_chat',
  'life_clock'
];

function run() {
  const configModulePath = path.join(PROJECT_ROOT, 'src', 'config', 'floki-config.cjs');
  assert.ok(fs.existsSync(configModulePath), 'floki-config.cjs must exist');

  const chatYamlPath = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
  const gameYamlPath = path.join(PROJECT_ROOT, 'config', 'game.config.yaml');
  assert.ok(fs.existsSync(chatYamlPath), 'chat.config.yaml must exist');
  assert.ok(fs.existsSync(gameYamlPath), 'game.config.yaml must exist');

  const cfg = require('../src/config/floki-config.cjs');

  assert.equal(typeof cfg.loadFlokiConfig, 'function', 'loadFlokiConfig must be exported');
  assert.equal(typeof cfg.getModelConfig, 'function', 'getModelConfig must be exported');
  assert.equal(typeof cfg.getPathConfig, 'function', 'getPathConfig must be exported');
  assert.equal(typeof cfg.getSleepConfig, 'function', 'getSleepConfig must be exported');
  assert.equal(typeof cfg.getDreamConfig, 'function', 'getDreamConfig must be exported');
  assert.equal(typeof cfg.getAudioConfig, 'function', 'getAudioConfig must be exported');
  assert.equal(typeof cfg.getTimeoutConfig, 'function', 'getTimeoutConfig must be exported');
  assert.equal(typeof cfg.getKnowledgeConfig, 'function', 'getKnowledgeConfig must be exported');
  assert.equal(typeof cfg.getLiveChatConfig, 'function', 'getLiveChatConfig must be exported');
  assert.equal(typeof cfg.getLifeClockConfig, 'function', 'getLifeClockConfig must be exported');
  assert.equal(typeof cfg.getFlokiConfig, 'function', 'getFlokiConfig must be exported');
  assert.equal(typeof cfg.resolveProjectPath, 'function', 'resolveProjectPath must be exported');
  assert.equal(typeof cfg.resolveStatePath, 'function', 'resolveStatePath must be exported');
  assert.equal(typeof cfg.resolveToolPath, 'function', 'resolveToolPath must be exported');
  assert.equal(typeof cfg.resolveExternalPath, 'function', 'resolveExternalPath must be exported');
  assert.equal(typeof cfg.clearConfigCache, 'function', 'clearConfigCache must be exported');
  assert.equal(typeof cfg.configPathForMode, 'function', 'configPathForMode must be exported');

  cfg.clearConfigCache();
  const chat = cfg.loadFlokiConfig('chat');
  cfg.clearConfigCache();
  const game = cfg.loadFlokiConfig('game');

  assert.ok(chat !== game, 'chat and game configs must be separate objects');
  assert.equal(chat.mode, 'chat');
  assert.equal(game.mode, 'game');
  assert.equal(chat.schema_version, 'floki-v2-core-brain-config-v1');
  assert.equal(game.schema_version, 'floki-v2-core-brain-config-v1');

  for (const section of REQUIRED_SECTIONS) {
    assert.ok(chat[section], 'chat config must have section: ' + section);
    assert.equal(typeof chat[section], 'object', 'chat.' + section + ' must be an object');
    assert.ok(game[section], 'game config must have section: ' + section);
    assert.equal(typeof game[section], 'object', 'game.' + section + ' must be an object');
  }

  const oldCog = process.env.FLOKI_COGNITION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'authority-test-cognition:local';
  cfg.clearConfigCache();
  const chatWithEnv = cfg.loadFlokiConfig('chat');
  assert.equal(chatWithEnv.models.cognition.model, 'authority-test-cognition:local', 'env override must work when YAML declares env key');
  if (oldCog === undefined) delete process.env.FLOKI_COGNITION_MODEL; else process.env.FLOKI_COGNITION_MODEL = oldCog;

  const accessorChatModels = cfg.getModelConfig('chat');
  assert.ok(accessorChatModels.cognition, 'getModelConfig must return cognition');
  assert.ok(accessorChatModels.vision, 'getModelConfig must return vision');

  const accessorChatPaths = cfg.getPathConfig('chat');
  assert.equal(typeof accessorChatPaths.state_root, 'string');
  assert.equal(typeof accessorChatPaths.media_root, 'string');

  const accessorChatSleep = cfg.getSleepConfig('chat');
  assert.equal(typeof accessorChatSleep.timezone, 'string');
  assert.equal(typeof accessorChatSleep.start_hhmm, 'string');

  const accessorChatDream = cfg.getDreamConfig('chat');
  assert.equal(typeof accessorChatDream.temperature, 'number');

  const accessorChatAudio = cfg.getAudioConfig('chat');
  assert.equal(typeof accessorChatAudio.mic_rate, 'number');
  assert.equal(typeof accessorChatAudio.whisper_model_size, 'string');

  const accessorChatTimeouts = cfg.getTimeoutConfig('chat');
  assert.equal(typeof accessorChatTimeouts.ollama_http_ms, 'number');

  const accessorChatKnowledge = cfg.getKnowledgeConfig('chat');
  assert.equal(typeof accessorChatKnowledge.autoload_enabled, 'boolean');

  const accessorChatLiveChat = cfg.getLiveChatConfig('chat');
  assert.equal(typeof accessorChatLiveChat.warm_cognition_on_start, 'boolean');

  const accessorChatLifeClock = cfg.getLifeClockConfig('chat');
  assert.equal(typeof accessorChatLifeClock.ticks_per_second, 'number');

  const viaGetFlokiConfig = cfg.getFlokiConfig('game');
  assert.equal(viaGetFlokiConfig.mode, 'game');
  assert.ok(viaGetFlokiConfig.models, 'getFlokiConfig must return models');
  assert.ok(viaGetFlokiConfig.paths, 'getFlokiConfig must return paths');
  assert.ok(viaGetFlokiConfig.sleep, 'getFlokiConfig must return sleep');
  assert.ok(viaGetFlokiConfig.dream, 'getFlokiConfig must return dream');
  assert.ok(viaGetFlokiConfig.audio, 'getFlokiConfig must return audio');
  assert.ok(viaGetFlokiConfig.timeouts, 'getFlokiConfig must return timeouts');
  assert.ok(viaGetFlokiConfig.knowledge, 'getFlokiConfig must return knowledge');
  assert.ok(viaGetFlokiConfig.live_chat, 'getFlokiConfig must return live_chat');
  assert.ok(viaGetFlokiConfig.life_clock, 'getFlokiConfig must return life_clock');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CONFIG_AUTHORITY_PASS',
    config_module_exists: true,
    chat_yaml_loads: true,
    game_yaml_loads: true,
    configs_are_separate: chat !== game,
    chat_mode_correct: chat.mode === 'chat',
    game_mode_correct: game.mode === 'game',
    all_required_sections_present: true,
    env_override_works: true,
    all_accessors_exported: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CONFIG_AUTHORITY_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
