'use strict';

const assert = require('node:assert/strict');

const {
  cloneDefaultIdentityState
} = require('../src/brain/identity-state-schema.cjs');
const { createMemoryRecord } = require('../src/brain/memory-record-schema.cjs');
const {
  identityDeltaFromMemory
} = require('../brain/pineal/index.cjs');
const {
  buildChatRuntimeCapabilities
} = require('../src/vision/chat-webcam-vision-context.cjs');

function run() {
  const defaults = cloneDefaultIdentityState();

  assert.equal(defaults.self_model.has_body_now, false);
  assert.equal(defaults.self_model.has_eyes_now, false);
  assert.equal(defaults.self_model.has_chat_world_webcam_eyes, true);
  assert.equal(defaults.self_model.chat_world_eyes_available_now, false);
  assert.equal(defaults.self_model.has_game_world_eyes_now, false);
  assert.equal(defaults.self_model.has_cognition_model_now, true);
  assert.equal(defaults.self_model.has_broca_voice_now, true);
  assert.equal(defaults.self_summary.includes('before body and eyes'), false);
  assert.equal(defaults.continuity_summary.includes('before receiving a body or eyes'), false);

  const memory = createMemoryRecord({
    stream: 'short_term',
    type: 'experience',
    source: 'test',
    content: {
      summary: 'The user asked what I can see.',
      detail: ''
    },
    tags: ['chat', 'vision'],
    importance: 0.8,
    confidence: 1
  });

  const live = identityDeltaFromMemory(
    memory,
    {},
    buildChatRuntimeCapabilities({
      available: true,
      fresh: true,
      source: 'webcam',
      sight_scope: 'maker_world_external',
      observation_summary: 'A person is seated in a room.'
    })
  );

  assert.equal(live.self_model.has_eyes_now, true);
  assert.equal(live.self_model.chat_world_eyes_available_now, true);
  assert.equal(live.self_model.has_game_world_eyes_now, false);
  assert.equal(live.self_model.has_body_now, false);
  assert.equal(live.self_model.has_cognition_model_now, true);
  assert.equal(live.self_model.has_broca_voice_now, true);

  const offline = identityDeltaFromMemory(
    memory,
    {},
    buildChatRuntimeCapabilities({
      available: false,
      unavailable_reason: 'stale_observation'
    })
  );

  assert.equal(offline.self_model.has_eyes_now, false);
  assert.equal(offline.self_model.chat_world_eyes_available_now, false);
  assert.equal(offline.self_summary.includes('permanently blind'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_IDENTITY_RUNTIME_TRUTH_PASS',
    cognition_active_in_identity: true,
    broca_voice_active_in_identity: true,
    chat_webcam_capability_persistent: true,
    current_sight_is_runtime_state: true,
    minecraft_body_claimed: false,
    game_vision_claimed: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
