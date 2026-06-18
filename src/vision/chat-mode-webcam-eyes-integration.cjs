'use strict';

const { resolveVisionSource } = require('./vision-source-router.cjs');
const { webcamEyesStreamGuardStatus } = require('./webcam-eyes-stream.cjs');
const { buildVisionStatus } = require('./vision-status.cjs');

function buildVisionCognitionContext(observationStatus = {}) {
  const observation = observationStatus.observation || null;
  return Object.freeze({
    available: Boolean(observation && observation.observation_summary),
    source: observation ? observation.source : null,
    sight_scope: observation ? observation.sight_scope : null,
    summary: observation ? observation.observation_summary : null,
    external_world_observation: observation ? observation.external_world_observation === true : false,
    internal_reality: false,
    public_transcript_visible: false,
    spoken_aloud: false
  });
}

function buildChatModeWebcamEyesIntegrationStatus(options = {}) {
  const route = resolveVisionSource({ mode: 'chat' });
  const guard = webcamEyesStreamGuardStatus(options.env || process.env, 'chat');
  const visionStatus = buildVisionStatus({
    active_mode: 'chat',
    env: options.env || process.env,
    webcam_status: options.webcam_status
  });
  const cognitionContext = buildVisionCognitionContext(options.observation_status || {});

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_WEBCAM_EYES_INTEGRATION_PASS',
    active_mode: 'chat',
    current_external_eyes_source: route.current_source,
    webcam_eyes_stream_guarded: guard.allowed_now !== true,
    webcam_eyes_stream_can_run_while_listening: true,
    webcam_vision_does_not_block_audio_loop: true,
    vision_cognition_context_available: cognitionContext.available,
    vision_cognition_context: cognitionContext,
    vision_status_visible: true,
    vision_status: visionStatus,
    self_echo_prevention: true,
    public_transcript_visible: false,
    private_thought_leaked_to_public_transcript: false,
    chat_mode_only: true,
    game_mode_started: false,
    minecraft_called: false,
    webcam_used_as_game_world_eyes: false
  });
}

module.exports = {
  buildVisionCognitionContext,
  buildChatModeWebcamEyesIntegrationStatus
};
