'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  loadSleepCycleState,
  recordWakeActivityIfSleeping,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');
const {
  runSpokenReplyOnce
} = require('../src/senses/spoken-reply-once.cjs');

async function run() {
  const unique = newId('sleep_wake_resume').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-wake-resume/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  ensureDirSync(baseDir);

  let dreamCalls = 0;
  const firstRem = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:31:00.000Z',
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function(input) {
      dreamCalls += 1;
      return {
        ok: true,
        dream_txt_file: path.join(baseDir, 'dream-' + input.rem_cycle_number + '.txt'),
        dream_metadata_file: path.join(baseDir, 'dream-' + input.rem_cycle_number + '.json')
      };
    },
    write_report: false
  });
  assert.equal(firstRem.rem_cycles_completed, 1);
  assert.equal(dreamCalls, 1);

  const beforeInterrupt = loadSleepCycleState({ state_file: stateFile });
  const wake = recordWakeActivityIfSleeping({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:32:00.000Z',
    state_file: stateFile,
    events_file: eventsFile,
    reason: 'wake_gated_user_input'
  });
  assert.equal(wake.sleep_interrupted_by_wake, true);

  const interrupted = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:33:59.000Z',
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function() {
      throw new Error('dream should not run while interrupted before idle threshold');
    },
    write_report: false
  });
  assert.equal(interrupted.interrupted_now, false);
  assert.equal(interrupted.resumed_after_idle, false);
  assert.equal(interrupted.rem_cycles_completed, 1);

  const resumed = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:34:00.000Z',
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function() {
      throw new Error('no new REM cycle is due at resume instant');
    },
    write_report: false
  });
  assert.equal(resumed.resumed_after_idle, true);
  assert.equal(resumed.idle_resume_seconds, 120);
  assert.equal(resumed.rem_cycles_completed, 1);
  assert.equal(resumed.rem_cycles_pending, 4);

  const afterResume = loadSleepCycleState({ state_file: stateFile });
  assert.equal(afterResume.current_sleep_date, beforeInterrupt.current_sleep_date);
  assert.equal(afterResume.sleep_window_start, beforeInterrupt.sleep_window_start);
  assert.equal(afterResume.rem_cycles[0].status, 'complete');
  assert.equal(afterResume.rem_cycles[1].status, 'pending');
  assert.equal(afterResume.resumed_after_interruption_count, 1);

  let recorderCalled = false;
  const fakeWav = path.join(baseDir, 'fake.wav');
  fs.writeFileSync(fakeWav, Buffer.concat([
    Buffer.from('RIFF0000WAVE', 'ascii'),
    Buffer.alloc(68)
  ]));
  const spoken = await runSpokenReplyOnce({
    env: { FLOKI_ALLOW_SPOKEN_REPLY_ONCE: '1', FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    hearing_runner: function() {
      return {
        ok: true,
        report_file: path.join(baseDir, 'hearing.json'),
        heard_text: 'Hey Floki, did you dream last night?',
        microphone_recorded_now: false,
        microphone_capture_replay_used: true,
        vad_audio_analysis_run_now: true,
        whisper_transcription_run_now: true
      };
    },
    bridge_runner: async function() {
      return {
        ok: true,
        marker: 'FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_PASS',
        report_file: path.join(baseDir, 'bridge.json'),
        original_heard_text: 'Hey Floki, did you dream last night?',
        wake_routed_to_cognition: true,
        qwen_cognition_run_now: true,
        schema_constrained_json: true,
        model_json_fallback_used: false,
        broca_enabled_now: true,
        broca_text_response_created_now: true,
        broca_text_response: 'I can answer from memory.',
        piper_speech_run_now: true,
        piper_wav_created_now: true,
        speaker_playback_run_now: false,
        piper_wav_output_file: fakeWav,
        piper_wav_output_ready: true,
        piper_wav_output_size_bytes: 80,
        chat_mode_only: true
      };
    },
    locked_playback_runner: function() {
      return {
        ok: true,
        speaker_playback_run_now: true,
        voice_output_lock_started: true,
        ears_muted_during_playback: true,
        voice_output_lock_cleared_after_playback: true,
        ears_open_after_playback: true
      };
    },
    sleep_interruption_recorder: function() {
      recorderCalled = true;
      return {
        ok: true,
        sleep_interrupted_by_wake: true,
        chat_mode_only: true,
        game_mode_started: false
      };
    },
    write_report: false,
    write_bridge_report: false
  });
  assert.equal(spoken.ok, true);
  assert.equal(recorderCalled, true);
  assert.equal(spoken.sleep_interrupted_by_wake, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_WAKE_RESUME_CONTRACT_PASS',
    sleep_interrupted_by_wake: true,
    sleep_resumed_after_idle: resumed.resumed_after_idle,
    idle_resume_seconds: resumed.idle_resume_seconds,
    sleep_cycle_continued_not_restarted: afterResume.current_sleep_date === beforeInterrupt.current_sleep_date,
    rem_cycles_preserved_after_interruption: afterResume.rem_cycles[0].status === 'complete',
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_WAKE_RESUME_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
