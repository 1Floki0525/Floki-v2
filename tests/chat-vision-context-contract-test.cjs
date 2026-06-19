'use strict';

const assert = require('node:assert/strict');

const {
  normalizeChatWebcamVisionContext,
  buildChatRuntimeCapabilities
} = require('../src/vision/chat-webcam-vision-context.cjs');

function run() {
  const visible = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_age_ms: 300,
    latest_private_observation_timestamp: '2026-06-19T15:50:58.112Z',
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: 'A person is seated in a room with framed photographs.'
  });

  assert.equal(visible.available, true);
  assert.equal(visible.fresh, true);
  assert.equal(visible.public_transcript_visible, false);
  assert.equal(visible.game_mode_started, false);

  const capabilities = buildChatRuntimeCapabilities(visible);
  assert.equal(capabilities.has_body_now, false);
  assert.equal(capabilities.has_eyes_now, true);
  assert.equal(capabilities.has_chat_world_webcam_eyes, true);
  assert.equal(capabilities.chat_world_eyes_available_now, true);
  assert.equal(capabilities.has_game_world_eyes_now, false);
  assert.equal(capabilities.has_cognition_model_now, true);
  assert.equal(capabilities.has_broca_voice_now, true);

  const unavailable = normalizeChatWebcamVisionContext({
    available: false,
    stale: true,
    unavailable_reason: 'stale_observation',
    observation_summary: 'This stale private content must not be used.'
  });

  assert.equal(unavailable.available, false);
  assert.equal(unavailable.observation_summary, null);
  assert.equal(unavailable.unavailable_reason, 'stale_observation');
  assert.equal(buildChatRuntimeCapabilities(unavailable).has_eyes_now, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_CONTEXT_PASS',
    fresh_chat_sight_supported: true,
    stale_private_summary_suppressed: true,
    minecraft_body_claimed: false,
    game_vision_claimed: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run();
