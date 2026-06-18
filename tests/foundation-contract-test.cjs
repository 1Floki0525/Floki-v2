'use strict';

/**
 * Floki-v2 foundation contract test.
 *
 * This proves the production foundation files load, validate, and reject unsafe
 * hidden-reasoning storage markers.
 */

const assert = require('node:assert/strict');

const time = require('../src/util/time.cjs');
const ids = require('../src/util/ids.cjs');
const fsSafe = require('../src/util/fs-safe.cjs');
const jsonl = require('../src/util/jsonl.cjs');
const events = require('../src/brain/brain-event-schema.cjs');
const outputs = require('../src/brain/brain-output-schema.cjs');
const models = require('../src/config/model-config.cjs');
const runtime = require('../src/config/runtime-config.cjs');

function run() {
  const event = events.makeUserTextEvent('Hello Floki.');
  const speech = outputs.makeSpeechOutput('I hear you.', {
    parent_event_ids: [event.id]
  });

  events.validateBrainEvent(event);
  outputs.validateBrainOutput(speech);
  models.validateModelConfig(models.MODEL_CONFIG);
  runtime.validateRuntimeConfig();
  runtime.validateNodeRuntime(process.version);

  assert.ok(typeof models.getCognitionConfig().model === 'string' && models.getCognitionConfig().model.length > 0, 'cognition model from YAML must be non-empty');
  assert.ok(typeof models.getVisionConfig().model === 'string' && models.getVisionConfig().model.length > 0, 'vision model from YAML must be non-empty');
  assert.equal(models.getVisionConfig().enabled_in_current_stage, false);
  assert.equal(runtime.RUNTIME_CONFIG.java.target_major, 25);
  assert.equal(runtime.RUNTIME_CONFIG.papermc.future_target_server_version, '26.1.2');
  assert.equal(runtime.RUNTIME_CONFIG.papermc.enabled_in_current_stage, false);

  assert.throws(() => {
    events.createBrainEvent({
      type: 'user_text',
      source: 'user',
      modality: 'text',
      payload: {
        text: '<think>raw hidden reasoning</think>'
      }
    });
  }, /banned reasoning marker/);

  assert.throws(() => {
    outputs.createBrainOutput({
      type: 'speech',
      source: 'frontal',
      payload: {
        text: 'This should not be allowed.'
      }
    });
  }, /only Broca may produce speech outputs/);

  const diagPath = fsSafe.statePath('diagnostics.jsonl');
  jsonl.appendJsonlSync(diagPath, {
    id: ids.diagnosticId(),
    created_at: time.nowIso(),
    stage: 'stage_02_runtime_policy',
    result: 'FOUNDATION_CONTRACT_PASS'
  });

  const recent = jsonl.readJsonlSync(diagPath, {
    limit: 25
  });

  assert.ok(recent.length >= 1);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FOUNDATION_CONTRACT_PASS',
    node_version: process.version,
    java_target_major: runtime.RUNTIME_CONFIG.java.target_major,
    future_papermc_target: runtime.RUNTIME_CONFIG.papermc.future_target_server_version,
    cognition_model: models.getCognitionConfig().model,
    vision_model: models.getVisionConfig().model,
    minecraft_enabled_now: runtime.RUNTIME_CONFIG.papermc.enabled_in_current_stage
  }, null, 2));
}

run();
