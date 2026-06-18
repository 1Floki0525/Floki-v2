'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createVoiceOutputLock } = require('../src/chat/voice-output-lock.cjs');

const {
  chatModeLoopGuardStatus,
  parseTurnCount,
  runChatModeLoop
} = require('../src/senses/chat-mode-loop.cjs');

async function run() {
  const unique = newId('chat_mode_loop_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-mode-loop-guard/' + unique);
  const reportFile = path.join(baseDir, 'blocked-loop-report.json');
  const mutedReportFile = path.join(baseDir, 'muted-loop-report.json');
  const lockFile = path.join(baseDir, 'voice-output-lock.json');
  let spokenRunnerCalled = false;

  const guard = chatModeLoopGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.required_env, 'FLOKI_ALLOW_CHAT_MODE_LOOP=1');
  assert.equal(guard.microphone_recorded_now, false);
  assert.equal(guard.qwen_cognition_run_now, false);
  assert.equal(guard.speaker_playback_run_now, false);
  assert.equal(guard.chat_mode_only, true);

  const blocked = await runChatModeLoop({
    env: {},
    report_file: reportFile
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.marker, 'FLOKI_V2_CHAT_MODE_LOOP_BLOCKED');
  assert.equal(blocked.chat_mode_loop_run_now, false);
  assert.equal(blocked.microphone_recorded_now, false);
  assert.equal(blocked.qwen_cognition_run_now, false);
  assert.equal(blocked.speaker_playback_run_now, false);

  const lock = createVoiceOutputLock({
    lock_file: lockFile
  });

  lock.beginSpeaking({
    source: 'speaker_playback',
    output_id: 'guard_contract_output',
    text_hash: 'guard_contract',
    now_ms: 1000,
    ttl_ms: 60000
  });

  const muted = await runChatModeLoop({
    env: {
      FLOKI_ALLOW_CHAT_MODE_LOOP: '1',
      FLOKI_CHAT_MODE_LOOP_TURNS: '2'
    },
    report_file: mutedReportFile,
    voice_lock_file: lockFile,
    voice_lock_now_ms: 2000,
    spoken_reply_runner: function() {
      spokenRunnerCalled = true;
      throw new Error('spoken runner must not be called while voice lock is active');
    }
  });

  assert.equal(muted.ok, false);
  assert.equal(muted.marker, 'FLOKI_V2_CHAT_MODE_LOOP_FAIL');
  assert.equal(muted.turns_attempted, 1);
  assert.equal(muted.turns_completed, 0);
  assert.equal(muted.turns[0].marker, 'FLOKI_V2_CHAT_MODE_LOOP_TURN_BLOCKED_BY_VOICE_LOCK');
  assert.equal(spokenRunnerCalled, false);
  assert.equal(muted.microphone_recorded_now, false);
  assert.equal(muted.vad_audio_analysis_run_now, false);
  assert.equal(muted.whisper_transcription_run_now, false);
  assert.equal(muted.wake_gate_checked_now, false);
  assert.equal(muted.wake_routed_to_cognition, false);
  assert.equal(muted.qwen_cognition_run_now, false);
  assert.equal(muted.broca_enabled_now, false);
  assert.equal(muted.piper_speech_run_now, false);
  assert.equal(muted.speaker_playback_run_now, false);

  assert.equal(parseTurnCount('0'), 1);
  assert.equal(parseTurnCount('2'), 2);
  assert.equal(parseTurnCount('999'), 10);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_GUARD_CONTRACT_PASS',
    requires_explicit_env: true,
    blocked_without_loop_env: true,
    voice_lock_blocks_next_capture: true,
    spoken_runner_called_while_muted: spokenRunnerCalled,
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
    marker: 'FLOKI_V2_CHAT_MODE_LOOP_GUARD_CONTRACT_FAIL',
    error: error.message
  }, null, 2));
  process.exit(1);
});
