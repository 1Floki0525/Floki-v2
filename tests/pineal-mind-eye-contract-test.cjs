'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPinealMindEye } = require('../src/vision/pineal-mind-eye.cjs');

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const innerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pineal-'));
  const status = runPinealMindEye({
    inner_vision_root: innerRoot,
    dreams: ['lanterns in a rain-lit archive'],
    thoughts: ['quiet reflection about being careful'],
    memories: ['a conversation about trust'],
    youtube_transcripts: ['a transcript about forests and bridges'],
    minecraft_experience: ['a remembered first-person cave entrance'],
    emotions: ['curiosity'],
    personality: ['gentle persistence'],
    beliefs: ['truth must stay separate from imagination']
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_PINEAL_MIND_EYE_CONTRACT_PASS');
  assert.equal(status.internal_reality, true);
  assert.equal(status.external_world_observation, false);
  assert.equal(status.public_transcript_visible, false);
  assert.equal(status.spoken_aloud, false);
  assert.equal(status.scene.public_transcript_visible, false);
  assert.equal(status.scene.spoken_aloud, false);
  assert.equal(status.webcam_used, false);
  assert.equal(status.minecraft_first_person_used, false);
  assert.equal(status.private_inner_vision_written, true);
  assert.equal(fs.existsSync(status.private_inner_vision_file), true);
  assert.equal(status.scene.youtube_transcripts_used, true);
  assert.equal(status.scene.minecraft_experience_used, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_PINEAL_MIND_EYE_CONTRACT_PASS',
    internal_reality: true,
    external_world_observation: false,
    public_transcript_visible: false,
    spoken_aloud: false,
    scene_public_transcript_visible: false,
    scene_spoken_aloud: false,
    private_inner_vision_written: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_PINEAL_MIND_EYE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
