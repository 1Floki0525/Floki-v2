'use strict';

const assert = require('node:assert/strict');

const {
  playbackAllowed,
  speakerPlaybackGuardStatus,
  runPiperSpeakerPlaybackProof
} = require('../src/senses/piper-speaker-playback.cjs');

function run() {
  assert.equal(playbackAllowed({}), false);
  assert.equal(playbackAllowed({ FLOKI_ALLOW_SPEAKER_PLAYBACK: '0' }), false);
  assert.equal(playbackAllowed({ FLOKI_ALLOW_SPEAKER_PLAYBACK: '1' }), true);

  const guard = speakerPlaybackGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.speaker_playback_run_now, false);

  const blocked = runPiperSpeakerPlaybackProof({
    env: {},
    text: 'This must not play.'
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_BLOCKED');
  assert.equal(blocked.piper_speech_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.webcam_opened_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.minecraft_called, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_GUARD_PASS',
    default_playback_allowed: false,
    explicit_playback_env_required: 'FLOKI_ALLOW_SPEAKER_PLAYBACK=1',
    blocked_without_env: true,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    minecraft_called: false
  }, null, 2));
}

run();
