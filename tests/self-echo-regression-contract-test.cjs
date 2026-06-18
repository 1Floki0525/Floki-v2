'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createVoiceOutputLock } = require('../src/chat/voice-output-lock.cjs');
const { runMicrophoneCaptureProof } = require('../src/senses/microphone-capture-smoke.cjs');
const { runPlaybackWithVoiceLock } = require('../src/senses/piper-speaker-playback.cjs');
const { runChatModeLoop } = require('../src/senses/chat-mode-loop.cjs');

const {
  applyWakeGateToHeardText,
  assertWakeRoutedHeardText,
  runHearingToCognitionBridgeProof
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function makeFakeWav(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from('RIFF0000WAVEfmt ', 'ascii'),
    Buffer.alloc(4096)
  ]));
}

function writeFakeHearingReport(baseDir, heardText) {
  ensureDirSync(baseDir);
  const filePath = path.join(baseDir, 'self-echo-hearing.json');

  fs.writeFileSync(filePath, JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_HEARING_LOOP_PASS',
    heard_text: heardText,
    heard_text_length: heardText.length,
    heard_word_count: heardText.split(/\s+/).filter(Boolean).length,
    capture: {
      output_file: '/tmp/self-echo.wav'
    },
    whisper: {
      report_file: '/tmp/self-echo-whisper.json'
    }
  }, null, 2) + '\n');

  return filePath;
}

async function run() {
  const unique = newId('self_echo_regression').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/self-echo-regression/' + unique);
  const lockFile = path.join(baseDir, 'voice-output-lock.json');
  const wavFile = path.join(baseDir, 'speaker.wav');
  const activeMs = 100000;
  let loopSpokenRunnerCalled = false;
  let playbackSawMutedEars = false;

  makeFakeWav(wavFile);

  const lock = createVoiceOutputLock({
    lock_file: lockFile
  });

  lock.beginSpeaking({
    source: 'speaker_playback',
    output_id: 'self_echo_regression_output',
    text_hash: 'hey_floki_self_echo',
    now_ms: activeMs,
    ttl_ms: 60000
  });

  const directMic = runMicrophoneCaptureProof({
    env: {
      FLOKI_ALLOW_MICROPHONE_CAPTURE: '1'
    },
    voice_lock_file: lockFile,
    voice_lock_now_ms: activeMs + 1000,
    output_file: path.join(baseDir, 'must-not-record.wav')
  });

  assert.equal(directMic.ok, false);
  assert.equal(directMic.marker, 'FLOKI_V2_MICROPHONE_CAPTURE_BLOCKED_BY_VOICE_LOCK');
  assert.equal(directMic.microphone_recorded_now, false);

  const wakeWhileLocked = applyWakeGateToHeardText({
    heard_text: 'Hey Floki, this is your own speaker output.',
    heard_text_length: 46,
    heard_word_count: 8,
    report_file: '/tmp/self-echo-report.json'
  }, {
    voice_lock_file: lockFile,
    voice_lock_now_ms: activeMs + 2000,
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(wakeWhileLocked.gate_open, false);
  assert.equal(wakeWhileLocked.routed_to_cognition, false);
  assert.equal(wakeWhileLocked.ears_must_be_muted, true);
  assert.equal(wakeWhileLocked.reason, 'voice_speaking_ears_muted');

  const hearingReport = writeFakeHearingReport(
    path.join(baseDir, 'bridge-input'),
    'Hey Floki, this is your own speaker output.'
  );

  const bridgeMuted = await runHearingToCognitionBridgeProof({
    env: {
      FLOKI_ALLOW_HEARING_TO_COGNITION: '1'
    },
    write_report: false,
    hearing_report_file: hearingReport,
    voice_lock_file: lockFile,
    voice_lock_now_ms: activeMs + 3000,
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(bridgeMuted.ok, true);
  assert.equal(bridgeMuted.marker, 'FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_IGNORED');
  assert.equal(bridgeMuted.qwen_cognition_run_now, false);
  assert.equal(bridgeMuted.broca_enabled_now, false);
  assert.equal(bridgeMuted.piper_speech_run_now, false);
  assert.equal(bridgeMuted.speaker_playback_run_now, false);

  assert.throws(() => {
    assertWakeRoutedHeardText({
      heard_text: 'trust and hope without wake provenance'
    });
  }, /wake-gated routed/);

  const loopMuted = await runChatModeLoop({
    env: {
      FLOKI_ALLOW_CHAT_MODE_LOOP: '1',
      FLOKI_CHAT_MODE_LOOP_TURNS: '2'
    },
    voice_lock_file: lockFile,
    voice_lock_now_ms: activeMs + 4000,
    write_report: false,
    spoken_reply_runner: function() {
      loopSpokenRunnerCalled = true;
      throw new Error('loop must not start spoken reply while voice lock is active');
    }
  });

  assert.equal(loopMuted.ok, false);
  assert.equal(loopMuted.turns[0].marker, 'FLOKI_V2_CHAT_MODE_LOOP_TURN_BLOCKED_BY_VOICE_LOCK');
  assert.equal(loopSpokenRunnerCalled, false);
  assert.equal(loopMuted.microphone_recorded_now, false);
  assert.equal(loopMuted.qwen_cognition_run_now, false);
  assert.equal(loopMuted.broca_enabled_now, false);
  assert.equal(loopMuted.piper_speech_run_now, false);

  lock.endSpeaking({
    now_ms: activeMs + 5000,
    reason: 'reset_for_playback_contract'
  });

  function playbackRunner(filePath) {
    assert.equal(filePath, wavFile);

    playbackSawMutedEars = createVoiceOutputLock({
      lock_file: lockFile
    }).isEarsMuted({
      now_ms: activeMs + 6000
    }).ears_muted_now === true;

    return Object.freeze({
      ok: true,
      command: 'fake-aplay',
      exit_status: 0,
      stdout: '',
      stderr: ''
    });
  }

  const playback = runPlaybackWithVoiceLock(wavFile, {
    output_id: 'self_echo_playback_output',
    text_hash: 'self_echo_playback'
  }, {
    voice_lock_file: lockFile,
    voice_lock_start_now_ms: activeMs + 6000,
    voice_lock_end_now_ms: activeMs + 8000,
    playback_runner: playbackRunner
  });

  assert.equal(playback.ok, true);
  assert.equal(playbackSawMutedEars, true);
  assert.equal(playback.voice_output_lock_started, true);
  assert.equal(playback.ears_muted_during_playback, true);
  assert.equal(playback.voice_output_lock_cleared_after_playback, true);
  assert.equal(playback.ears_open_after_playback, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SELF_ECHO_REGRESSION_PASS',
    voice_lock_blocks_direct_microphone_capture: true,
    voice_lock_blocks_wake_gate_routing: true,
    simulated_wake_transcript_blocked_while_locked: true,
    speaker_playback_starts_lock_before_playback: playbackSawMutedEars,
    speaker_playback_clears_lock_afterward: playback.voice_output_lock_cleared_after_playback === true,
    continuous_loop_blocks_next_capture_while_locked: loopSpokenRunnerCalled === false,
    no_qwen_broca_piper_during_muted_ears_path: bridgeMuted.qwen_cognition_run_now === false &&
      bridgeMuted.broca_enabled_now === false &&
      bridgeMuted.piper_speech_run_now === false &&
      loopMuted.qwen_cognition_run_now === false &&
      loopMuted.broca_enabled_now === false &&
      loopMuted.piper_speech_run_now === false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    qwen_cognition_run_now: false,
    broca_enabled_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SELF_ECHO_REGRESSION_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
