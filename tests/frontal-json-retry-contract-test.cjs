'use strict';

const assert = require('node:assert/strict');

const {
  buildCognitionRetryPrompt,
  isJsonParseFailure,
  buildDeterministicCognitionFallback,
  normalizeCognitionJson
} = require('../brain/frontal/index.cjs');

function run() {
  assert.equal(typeof buildCognitionRetryPrompt, 'function');
  assert.equal(typeof isJsonParseFailure, 'function');
  assert.equal(typeof buildDeterministicCognitionFallback, 'function');
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
      short_term: [
        { summary: 'The user asked about trust and hope.' }
      ],
      long_term: [
        { summary: 'Trust and hope are important recurring themes.' }
      ]
    },
    emotional_reinforcement: {
      state: {
        trust: 0.2,
        hope: 0.2
      }
    }
  };

  const retryPrompt = buildCognitionRetryPrompt(
    context,
    'model response was not parseable JSON: Unterminated string'
  );

  assert.equal(typeof retryPrompt, 'string');
  assert.equal(retryPrompt.includes('Return valid JSON only'), true);
  assert.equal(retryPrompt.includes('safe_thought_summary'), true);
  assert.equal(retryPrompt.includes('response_intent_for_broca'), true);
  assert.equal(retryPrompt.includes('what do you remember about trust and hope?'), true);

  assert.equal(
    isJsonParseFailure(new Error('model response was not parseable JSON: Unterminated string')),
    true
  );

  assert.equal(
    isJsonParseFailure(new Error("Expected property name or '}' in JSON at position 1")),
    true
  );

  assert.equal(
    isJsonParseFailure(new Error('Ollama request timed out after 120000ms')),
    false
  );

  const fallback = buildDeterministicCognitionFallback(
    context,
    'model response was not parseable JSON'
  );

  assert.equal(typeof fallback.safe_thought_summary, 'string');
  assert.equal(fallback.safe_thought_summary.length > 0, true);
  assert.equal(typeof fallback.response_intent_for_broca, 'string');
  assert.equal(fallback.response_intent_for_broca.toLowerCase().includes('trust'), true);
  assert.equal(fallback.response_intent_for_broca.toLowerCase().includes('hope'), true);
  assert.equal(fallback.emotion_reflection_enabled, true);

  const normalized = normalizeCognitionJson(fallback, context);

  assert.equal(typeof normalized.safe_thought_summary, 'string');
  assert.equal(typeof normalized.felt_interpretation, 'string');
  assert.equal(Array.isArray(normalized.memory_links), true);
  assert.equal(Array.isArray(normalized.personality_implications), true);
  assert.equal(Array.isArray(normalized.identity_implications), true);
  assert.equal(typeof normalized.response_intent_for_broca, 'string');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FRONTAL_JSON_RETRY_CONTRACT_PASS',
    retry_prompt_available: true,
    malformed_json_detection_available: true,
    deterministic_fallback_available: true,
    fallback_normalizes_to_safe_cognition: true,
    chat_mode_only: true
  }, null, 2));
}

run();
