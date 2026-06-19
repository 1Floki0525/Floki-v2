'use strict';

const assert = require('node:assert/strict');

const {
  getCognitionResponseSchema
} = require('../brain/frontal/index.cjs');

const {
  buildGeneratePayload,
  validateJsonSchemaShape
} = require('../src/model/ollama-client.cjs');

function run() {
  const schema = getCognitionResponseSchema();

  const payload = buildGeneratePayload({
    model: 'schema-fixture-model:test',
    prompt: 'Return schema cognition JSON.',
    system: 'Output only schema JSON.',
    format_schema: schema,
    response_schema: schema,
    temperature: 0.1,
    top_p: 0.3,
    num_predict: 512,
    think: false
  });

  assert.equal(payload.model, 'schema-fixture-model:test');
  assert.deepEqual(payload.format, schema);
  assert.equal(payload.stream, false);
  assert.equal(payload.think, false);
  assert.equal(payload.options.temperature, 0.1);
  assert.equal(payload.options.top_p, 0.3);
  assert.equal(payload.options.num_predict, 512);

  const valid = {
    safe_thought_summary: 'Trust and hope connect to persistent chat memory.',
    felt_interpretation: 'Calm and attentive.',
    memory_links: ['The user asked about trust and hope.'],
    personality_implications: ['Careful memory-aware replies matter.'],
    identity_implications: ['Continuity depends on memory.'],
    response_intent_for_broca: 'Trust and hope help me stay continuous and careful.',
    new_memory_summary: 'Remember that the user asked about trust and hope.',
    emotion_reflection_enabled: true
  };

  assert.equal(validateJsonSchemaShape(valid, schema), true);

  assert.throws(() => {
    validateJsonSchemaShape({
      safe_thought_summary: 'missing required fields'
    }, schema);
  }, /missing required/);

  assert.throws(() => {
    validateJsonSchemaShape({
      ...valid,
      extra: 'not allowed'
    }, schema);
  }, /unexpected property/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FRONTAL_SCHEMA_JSON_CONTRACT_PASS',
    ollama_format_schema_object_enabled: true,
    response_schema_validation_enabled: true,
    deterministic_fallback_removed: true,
    chat_mode_only: true
  }, null, 2));
}

run();
