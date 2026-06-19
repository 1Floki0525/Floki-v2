'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChatWebcamVisionContext(input = {}) {
  const summary = typeof input.observation_summary === 'string'
    ? input.observation_summary.trim()
    : '';
  const available = input.available === true && summary.length > 0;
  const ageMs = finiteNumber(input.observation_age_ms);

  return Object.freeze({
    available,
    fresh: available && input.fresh !== false,
    stale: input.stale === true,
    observation_age_ms: ageMs,
    latest_private_observation_timestamp:
      typeof input.latest_private_observation_timestamp === 'string'
        ? input.latest_private_observation_timestamp
        : null,
    source: available
      ? (typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'webcam')
      : null,
    sight_scope: available
      ? (typeof input.sight_scope === 'string' && input.sight_scope.trim()
          ? input.sight_scope.trim()
          : 'maker_world_external')
      : null,
    observation_summary: available ? summary.slice(0, 1000) : null,
    unavailable_reason: available
      ? null
      : (typeof input.unavailable_reason === 'string' && input.unavailable_reason.trim()
          ? input.unavailable_reason.trim()
          : 'no_fresh_observation'),
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function buildChatRuntimeCapabilities(visionInput = {}) {
  const vision = normalizeChatWebcamVisionContext(visionInput);

  return Object.freeze({
    has_body_now: false,
    has_eyes_now: vision.available,
    has_chat_world_webcam_eyes: true,
    chat_world_eyes_available_now: vision.available,
    has_game_world_eyes_now: false,
    has_cognition_model_now: true,
    has_broca_voice_now: true,
    current_interface: 'chat with microphone, speakers, and webcam vision',
    current_sight_scope: vision.available ? vision.sight_scope : null
  });
}

module.exports = {
  normalizeChatWebcamVisionContext,
  buildChatRuntimeCapabilities
};
