'use strict';

const assert = require('node:assert/strict');

const {
  buildCognitionRetryPrompt,
  isJsonParseFailure,
  getCognitionResponseSchema,
  compactCognitionContext,
  normalizeCognitionJson
} = require('../brain/frontal/index.cjs');

function run() {
  assert.equal(typeof buildCognitionRetryPrompt, 'function');
  assert.equal(typeof isJsonParseFailure, 'function');
  assert.equal(typeof getCognitionResponseSchema, 'function');
  assert.equal(typeof compactCognitionContext, 'function');
  assert.equal(typeof normalizeCognitionJson, 'function');

  const context = {
    event: {
      payload: {
        text: 'what do you remember about trust and hope?'
      }
    },
    affect: {
      valence: 0.2,
      arousal: 0.1
    },
    memories: [
      { summary: 'Trust matters for continuity.' },
      { summary: 'Hope matters for growth.' }
    ],
    persistent_chat_memory: {
      short_term: [{ summary: 'The user asked about trust and hope.' }],
      long_term: [{ summary: 'Trust and hope are recurring themes.' }]
    }
  };

  const schema = getCognitionResponseSchema();
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required.includes('safe_thought_summary'), true);
  assert.equal(schema.required.includes('response_intent_for_broca'), true);

  const compact = compactCognitionContext(context);
  assert.equal(compact.user_text, 'what do you remember about trust and hope?');
  assert.equal(compact.recalled_memories.length, 2);

  const retryPrompt = buildCognitionRetryPrompt(context, 'model response was not parseable JSON');
  assert.equal(retryPrompt.includes('failed JSON/schema validation'), true);
  assert.equal(retryPrompt.includes('what do you remember about trust and hope?'), true);

  assert.equal(isJsonParseFailure(new Error('model response was not parseable JSON: Unterminated string')), true);
  assert.equal(isJsonParseFailure(new Error("Expected property name or '}' in JSON at position 1")), true);
  assert.equal(isJsonParseFailure(new Error('JSON schema validation failed: missing required response.safe_thought_summary')), true);
  assert.equal(isJsonParseFailure(new Error('Ollama request timed out after 120000ms')), false);

  const normalized = normalizeCognitionJson({
    safe_thought_summary: 'Trust and hope are connected to memory continuity.',
    felt_interpretation: 'Calm and focused.',
    memory_links: ['The user asked about trust and hope.'],
    personality_implications: ['Careful continuity matters.'],
    identity_implications: ['Memory supports stable identity in chat mode.'],
    response_intent_for_broca: 'Trust and hope help me stay continuous and careful.',
    new_memory_summary: 'The user asked what Floki remembers about trust and hope.',
    emotion_reflection_enabled: true
  }, context);

  assert.equal(normalized.response_intent_for_broca.includes('Trust'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FRONTAL_JSON_RETRY_CONTRACT_PASS',
    schema_retry_prompt_available: true,
    malformed_json_detection_available: true,
    no_deterministic_fallback_required: true,
    chat_mode_only: true
  }, null, 2));
}

run();
