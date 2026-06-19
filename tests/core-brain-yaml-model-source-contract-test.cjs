'use strict';

const assert = require('node:assert/strict');
const { loadCoreBrainConfig, validateCoreBrainConfig, normalizeModelSection } = require('../brain/core_brain/index.cjs');

function run() {
  const chat = loadCoreBrainConfig('chat');
  const game = loadCoreBrainConfig('game');
  validateCoreBrainConfig(chat);
  validateCoreBrainConfig(game);
  for (const config of [chat, game]) {
    assert.ok(config.models.cognition.model);
    assert.ok(config.models.vision.model);
  }
  const old = process.env.FLOKI_COGNITION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = 'ignored-environment-selection';
  const normalized = normalizeModelSection({provider:'ollama',model:chat.models.cognition.model,endpoint_env:'FLOKI_COGNITION_ENDPOINT',endpoint_default:'http://127.0.0.1:11434',temperature:0.55,top_p:0.9,timeout_ms:120000,keep_alive:'24h'}, 'cognition');
  assert.equal(normalized.model, chat.models.cognition.model);
  if (old === undefined) delete process.env.FLOKI_COGNITION_MODEL; else process.env.FLOKI_COGNITION_MODEL = old;
  assert.throws(() => normalizeModelSection({provider:'ollama',model:'',endpoint_default:'http://127.0.0.1:11434'}, 'cognition'), /cognition model must be non-empty/);
  console.log(JSON.stringify({ok:true,marker:'FLOKI_V2_CORE_BRAIN_YAML_MODEL_SOURCE_PASS',yaml_model_selection_source_of_truth:true,environment_model_override_supported:false,minecraft_enabled_now:false}, null, 2));
}
run();
