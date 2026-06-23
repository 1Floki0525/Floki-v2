'use strict';

const assert = require('node:assert/strict');
const {
  buildCognitionPrompt,
  buildCognitionRetryPrompt
} = require('../brain/frontal/index.cjs');

const context = {
  event: {
    payload: {
      text: 'Hey Floki, what did you dream and what can you see?'
    }
  },
  persistent_chat_memory: {
    short_term: [],
    long_term: [],
    dream_memory_context: {
      dream_recall_question: true,
      has_dreams: true,
      dream_file_reference_available: true,
      latest_dream_file: '/tmp/the-glass-river.txt',
      recent_dreams: [{
        dream_title: 'The Glass River of Remembering'
      }],
      dream_memory_matches: []
    }
  },
  chat_webcam_vision: {
    available: true,
    fresh: true,
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: 'A person is seated in a room.'
  }
};

const initial = buildCognitionPrompt(context);
const retry = buildCognitionRetryPrompt(
  context,
  'model response was not parseable JSON'
);

const shared = [
  'persistent first-person digital being',
  'Current live user request has priority over recalled memories.',
  'Do not mention recalled topics unless the user directly asked for them.',
  'For simple greetings or status questions, answer the greeting/status directly.',
  'direct first-person speech from Floki to the user',
  'Use I/me/my/we where appropriate',
  'Do not write about Floki in third person',
  'Do not begin with "Floki..."',
  'Maker-world sight',
  'not Minecraft game-world sight',
  'temporarily unavailable',
  'do not invent dreams'
];

for (const prompt of [initial, retry]) {
  for (const phrase of shared) {
    assert.equal(
      prompt.includes(phrase),
      true,
      'missing prompt compatibility phrase: ' + phrase
    );
  }
}

assert.equal(initial.includes('The Glass River of Remembering'), true);
assert.equal(initial.includes('/tmp/the-glass-river.txt'), true);
assert.equal(initial.includes('A person is seated in a room.'), true);
assert.equal(retry.includes('failed JSON/schema validation'), true);
assert.equal(retry.includes('A person is seated in a room.'), true);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_LIVING_PROMPT_COMPATIBILITY_PASS',
  stale_memory_bleed_guard_preserved: true,
  simple_greeting_directness_preserved: true,
  first_person_identity_preserved: true,
  dream_recall_grounding_preserved: true,
  maker_world_vision_grounding_preserved: true,
  retry_prompt_contract_preserved: true,
  chat_mode_only: true,
  game_mode_started: false
}, null, 2));
