'use strict';

const assert = require('node:assert/strict');

const {
  buildChatModeWebcamEyesIntegrationStatus
} = require('../src/vision/chat-mode-webcam-eyes-integration.cjs');

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const status = buildChatModeWebcamEyesIntegrationStatus({
    observation_status: {
      observation: {
        source: 'webcam',
        sight_scope: 'maker_world_external',
        observation_summary: 'A safe webcam observation is available for cognition context.',
        external_world_observation: true
      }
    }
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_MODE_WEBCAM_EYES_INTEGRATION_PASS');
  assert.equal(status.active_mode, 'chat');
  assert.equal(status.current_external_eyes_source, 'webcam');
  assert.equal(status.webcam_vision_does_not_block_audio_loop, true);
  assert.equal(status.vision_cognition_context_available, true);
  assert.equal(status.vision_cognition_context.public_transcript_visible, false);
  assert.equal(status.self_echo_prevention, true);
  assert.equal(status.private_thought_leaked_to_public_transcript, false);
  assert.equal(status.game_mode_started, false);
  assert.equal(status.webcam_used_as_game_world_eyes, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_WEBCAM_EYES_INTEGRATION_PASS',
    current_external_eyes_source: status.current_external_eyes_source,
    vision_cognition_context_available: true,
    webcam_vision_does_not_block_audio_loop: true,
    private_thought_leaked_to_public_transcript: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_MODE_WEBCAM_EYES_INTEGRATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
