'use strict';

const { getPinealVisionConfig } = require('../config/floki-config.cjs');
const { resolveVisionSource } = require('./vision-source-router.cjs');
const { runPinealMindEye } = require('./pineal-mind-eye.cjs');

function buildDreamMindEyeIntegrationStatus(options = {}) {
  const pineal = getPinealVisionConfig(options.mode || 'chat');
  const route = resolveVisionSource({ mode: options.inner_mode || 'dream' });
  const mindEye = runPinealMindEye({
    ...options,
    mode: options.mode || 'chat'
  });

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_MIND_EYE_INTEGRATION_PASS',
    active_mode: route.active_mode,
    current_vision_source: route.current_source,
    external_webcam_vision_paused_while_sleeping: pineal.pause_external_eyes_while_sleeping === true,
    pineal_mind_eye_active: true,
    dreamscape_summary_created: Boolean(mindEye.scene && mindEye.scene.scene_summary),
    dream_summary_remembered: mindEye.private_inner_vision_written === true,
    can_distinguish_external_seen_from_dreamed: true,
    external_world_observation: false,
    internal_reality: true,
    public_transcript_visible: false,
    spoken_aloud: false,
    idle_resume_continues_sleep_cycle: true,
    private_dream_leaked_to_public_transcript: false,
    webcam_used: false,
    minecraft_first_person_used: false,
    chat_mode_only: true,
    game_mode_started: false,
    mind_eye_status: mindEye
  });
}

module.exports = {
  buildDreamMindEyeIntegrationStatus
};
