'use strict';

const assert = require('node:assert/strict');

const {
  compactCognitionContext,
  buildCognitionPrompt,
  buildCognitionRetryPrompt
} = require('../brain/frontal/index.cjs');

function run() {
  const context = {
    event: {
      payload: {
        text: 'What can you see?'
      }
    },
    chat_webcam_vision: {
      available: true,
      fresh: true,
      observation_age_ms: 100,
      latest_private_observation_timestamp: '2026-06-19T15:50:58.112Z',
      source: 'webcam',
      sight_scope: 'maker_world_external',
      observation_summary: 'A person is seated in a room with framed photographs.'
    },
    vision_response_contract: {
      question: true,
      hardware_question: false,
      require_narrative: true,
      scene_instruction: 'Answer from my own current sight in natural first-person language.',
      unavailable_instruction: 'Say my sight is temporarily unavailable for this moment.',
      prohibited_terms: ['camera', 'detector']
    },
    identity: {
      name: 'Floki',
      self_model: {
        has_body_now: false,
        has_eyes_now: true,
        has_chat_world_webcam_eyes: true,
        chat_world_eyes_available_now: true,
        has_game_world_eyes_now: false,
        has_cognition_model_now: true,
        has_broca_voice_now: true
      }
    }
  };

  const compact = compactCognitionContext(context);
  assert.equal(compact.chat_webcam_vision.available, true);
  assert.equal(compact.chat_webcam_vision.fresh, true);
  assert.equal(
    compact.chat_webcam_vision.observation_summary,
    'A person is seated in a room with framed photographs.'
  );

  const first = buildCognitionPrompt(context);
  const retry = buildCognitionRetryPrompt(context, 'test retry');

  for (const prompt of [first, retry]) {
    assert.equal(prompt.includes('A person is seated in a room with framed photographs.'), true);
    assert.equal(prompt.includes('Maker-world sight'), true);
    assert.equal(prompt.includes('temporarily unavailable'), true);
    assert.equal(prompt.includes('not Minecraft game-world sight'), true);
  }

  assert.equal(retry.includes('"chat_webcam_vision"'), true);
  assert.equal(retry.includes('"identity"'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FRONTAL_VISION_CONTEXT_PASS',
    first_prompt_contains_live_sight: true,
    retry_prompt_contains_live_sight: true,
    temporary_unavailability_truth_present: true,
    game_mode_isolation_instruction_present: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
