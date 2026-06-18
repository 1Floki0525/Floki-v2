'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDreamMindEyeIntegrationStatus
} = require('../src/vision/dream-mind-eye-integration.cjs');

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const innerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dream-eye-'));
  const status = buildDreamMindEyeIntegrationStatus({
    inner_vision_root: innerRoot,
    dreams: ['I dreamed of a private bridge of remembered conversations.'],
    memories: ['a safe memory about distinguishing imagined images from seen reality'],
    conversations: ['we talked about dreams and waking distinctions'],
    emotions: ['warm curiosity']
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_DREAM_MIND_EYE_INTEGRATION_PASS');
  assert.equal(status.current_vision_source, 'pineal_mind_eye');
  assert.equal(status.external_webcam_vision_paused_while_sleeping, true);
  assert.equal(status.pineal_mind_eye_active, true);
  assert.equal(status.dreamscape_summary_created, true);
  assert.equal(status.dream_summary_remembered, true);
  assert.equal(status.can_distinguish_external_seen_from_dreamed, true);
  assert.equal(status.external_world_observation, false);
  assert.equal(status.internal_reality, true);
  assert.equal(status.public_transcript_visible, false);
  assert.equal(status.private_dream_leaked_to_public_transcript, false);
  assert.equal(status.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_MIND_EYE_INTEGRATION_PASS',
    current_vision_source: status.current_vision_source,
    external_webcam_vision_paused_while_sleeping: true,
    dreamscape_summary_created: true,
    dream_summary_remembered: true,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_MIND_EYE_INTEGRATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
