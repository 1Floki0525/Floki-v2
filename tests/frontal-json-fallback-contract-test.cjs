'use strict';

const assert = require('node:assert/strict');

const {
  isJsonParseFailure,
  buildDeterministicCognitionFallback,
  normalizeCognitionJson
} = require('../brain/frontal/index.cjs');

function run() {
  assert.equal(isJsonParseFailure(new Error('model response was not parseable JSON: Unterminated string')), true);
  assert.equal(isJsonParseFailure(new Error('Expected property name or } in JSON at position 1')), true);
  assert.equal(isJsonParseFailure(new Error('Ollama request timed out')), false);

  const fallback = buildDeterministicCognitionFallback({
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
      { summary: 'Trust matters.' },
      { summary: 'Hope matters.' }
    ]
  }, 'model response was not parseable JSON');

  assert.equal(typeof fallback.safe_thought_summary, 'string');
  assert.equal(fallback.safe_thought_summary.length > 0, true);
  assert.equal(typeof fallback.response_intent_for_broca, 'string');
  assert.equal(fallback.response_intent_for_broca.toLowerCase().includes('trust'), true);
  assert.equal(fallback.response_intent_for_broca.toLowerCase().includes('hope'), true);
  assert.equal(fallback.emotion_reflection_enabled, true);
  assert.equal(typeof fallback.model_json_fallback_reason, 'string');

  const normalized = normalizeCognitionJson(fallback, {});
  assert.equal(typeof normalized.safe_thought_summary, 'string');
  assert.equal(typeof normalized.felt_interpretation, 'string');
  assert.equal(Array.isArray(normalized.memory_links), true);
  assert.equal(Array.isArray(normalized.personality_implications), true);
  assert.equal(Array.isArray(normalized.identity_implications), true);
  assert.equal(typeof normalized.response_intent_for_broca, 'string');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FRONTAL_JSON_FALLBACK_CONTRACT_PASS',
    malformed_json_detected: true,
    deterministic_fallback_available: true,
    fallback_normalizes_to_safe_cognition: true,
    chat_mode_only: true
  }, null, 2));
}

run();
