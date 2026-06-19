'use strict';

const assert = require('node:assert/strict');

const { createBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { createBroca } = require('../brain/broca/index.cjs');

function cognition(intent) {
  return createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    payload: {
      model: 'vision-grounding-contract-model:local',
      cognition: {
        safe_thought_summary: 'I am answering from a fresh Maker-world visual observation.',
        felt_interpretation: '',
        memory_links: [],
        personality_implications: [],
        identity_implications: [],
        response_intent_for_broca: intent,
        new_memory_summary: 'I answered a visual question from current sight.',
        emotion_reflection_enabled: true
      },
      safe_summary_only: true,
      raw_private_reasoning_stored: false,
      normalized_model_json: true,
      schema_constrained_json: true,
      model_json_fallback_used: false
    },
    diagnostics: {
      module: 'frontal',
      status: 'vision_grounding_contract'
    }
  });
}

function run() {
  const broca = createBroca({ persist_diagnostics: false });
  const grounded = broca.speakFromCognition(
    cognition('I can see a person seated in a room with framed photographs.'),
    {}
  );

  assert.equal(grounded.type, 'speech');
  assert.equal(grounded.source, 'broca');
  assert.equal(grounded.payload.text.startsWith('I can see'), true);
  assert.equal(/Floki/.test(grounded.payload.text), false);
  assert.equal(/cannot see|no eyes|still digital|disembodied/i.test(grounded.payload.text), false);

  const thirdPerson = broca.speakFromCognition(
    cognition('Floki can see a person seated in a room.'),
    {}
  );

  assert.equal(thirdPerson.type, 'failure');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_BROCA_VISION_GROUNDING_PASS',
    grounded_first_person_sight_allowed: true,
    false_blindness_absent: true,
    third_person_self_narration_rejected: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
