'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createVoiceOutputLock } = require('../src/chat/voice-output-lock.cjs');

const {
  speakerPlaybackGuardStatus,
  runPlaybackWithVoiceLock,
  runPiperSpeakerPlaybackProof
} = require('../src/senses/piper-speaker-playback.cjs');

function makeFakeWav(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.from('RIFF0000WAVEfmt ', 'ascii');
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(2048)]));
}

function run() {
  const unique = newId('speaker_lock_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/speaker-playback-voice-lock/' + unique);
  const lockFile = path.join(baseDir, 'voice-output-lock.json');
  const wavFile = path.join(baseDir, 'fake-speaker.wav');

  makeFakeWav(wavFile);

  const blocked = speakerPlaybackGuardStatus({});
  assert.equal(blocked.ok, true);
  assert.equal(blocked.allowed_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);
  assert.equal(blocked.voice_output_lock_required, true);

  let playbackSawMutedEars = false;

  function fakePlaybackRunner(filePath) {
    assert.equal(filePath, wavFile);

    const lock = createVoiceOutputLock({
      lock_file: lockFile
    });

    const ears = lock.isEarsMuted({
      now_ms: 2000
    });

    playbackSawMutedEars = ears.ears_muted_now === true;

    return Object.freeze({
      ok: true,
      command: 'fake-aplay',
      exit_status: 0,
      stdout: '',
      stderr: ''
    });
  }

  const locked = runPlaybackWithVoiceLock(wavFile, {
    output_id: 'fake-speaker-output',
    text_hash: 'trust_hope_voice'
  }, {
    voice_lock_file: lockFile,
    voice_lock_start_now_ms: 1000,
    voice_lock_end_now_ms: 3000,
    playback_runner: fakePlaybackRunner
  });

  assert.equal(locked.ok, true);
  assert.equal(playbackSawMutedEars, true);
  assert.equal(locked.ears_muted_during_playback, true);
  assert.equal(locked.voice_output_lock_cleared_after_playback, true);
  assert.equal(locked.ears_open_after_playback, true);

  const after = createVoiceOutputLock({
    lock_file: lockFile
  }).isEarsMuted({
    now_ms: 4000
  });

  assert.equal(after.ears_muted_now, false);
  assert.equal(after.voice_output_lock_active, false);

  function fakeFailingPlaybackRunner() {
    return Object.freeze({
      ok: false,
      command: 'fake-aplay',
      exit_status: 1,
      stderr: 'simulated playback failure'
    });
  }

  const failed = runPlaybackWithVoiceLock(wavFile, {
    output_id: 'fake-failing-speaker-output',
    text_hash: 'failure_voice'
  }, {
    voice_lock_file: lockFile,
    voice_lock_start_now_ms: 5000,
    voice_lock_end_now_ms: 7000,
    playback_runner: fakeFailingPlaybackRunner
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.ears_muted_during_playback, true);
  assert.equal(failed.voice_output_lock_cleared_after_playback, true);
  assert.equal(failed.ears_open_after_playback, true);

  function fakeSynthesizer() {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_FAKE_PIPER_SPEECH_PASS',
      voice_size: 'large',
      voice_name: 'en_US-ryan-high',
      output_file: wavFile,
      output_ready: true,
      output_size_bytes: fs.statSync(wavFile).size,
      piper_speech_run_now: true,
      speaker_playback_run_now: false
    });
  }

  let proofPlaybackSawMutedEars = false;

  function fakeProofPlaybackRunner(filePath) {
    assert.equal(filePath, wavFile);

    const lock = createVoiceOutputLock({
      lock_file: lockFile
    });

    proofPlaybackSawMutedEars = lock.isEarsMuted({
      now_ms: 9000
    }).ears_muted_now === true;

    return Object.freeze({
      ok: true,
      command: 'fake-aplay',
      exit_status: 0,
      stdout: '',
      stderr: ''
    });
  }

  const proof = runPiperSpeakerPlaybackProof({
    env: {
      FLOKI_ALLOW_SPEAKER_PLAYBACK: '1'
    },
    piper_synthesizer: fakeSynthesizer,
    playback_runner: fakeProofPlaybackRunner,
    voice_lock_file: lockFile,
    voice_lock_start_now_ms: 8000,
    voice_lock_end_now_ms: 10000
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_PASS');
  assert.equal(proofPlaybackSawMutedEars, true);
  assert.equal(proof.voice_output_lock_started, true);
  assert.equal(proof.ears_muted_during_playback, true);
  assert.equal(proof.voice_output_lock_cleared_after_playback, true);
  assert.equal(proof.ears_open_after_playback, true);
  assert.equal(proof.piper_speech_run_now, true);
  assert.equal(proof.speaker_playback_run_now, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SPEAKER_PLAYBACK_VOICE_LOCK_CONTRACT_PASS',
    guard_requires_explicit_env: true,
    playback_saw_muted_ears: playbackSawMutedEars,
    proof_playback_saw_muted_ears: proofPlaybackSawMutedEars,
    failure_still_clears_voice_lock: failed.voice_output_lock_cleared_after_playback === true,
    voice_output_lock_started: proof.voice_output_lock_started,
    ears_muted_during_playback: proof.ears_muted_during_playback,
    voice_output_lock_cleared_after_playback: proof.voice_output_lock_cleared_after_playback,
    ears_open_after_playback: proof.ears_open_after_playback,
    piper_speech_run_now: true,
    speaker_playback_run_now: true,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run();
