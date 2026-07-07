'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  loadSleepCycleState,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');

async function waitOneTurn() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function runCompletionCase(baseDir) {
  const stateFile = path.join(baseDir, 'complete-state.json');
  const eventsFile = path.join(baseDir, 'complete-events.jsonl');
  let resolveDream;
  const pending = runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:31:00.000Z',
    // This durability scenario deliberately dispatches cycle 1 long after its
    // wall-clock slot; opt out of the 2026-07-06 truthful catch-up policy
    // (which would mark it 'missed') so the durable-state contract itself is
    // what gets exercised.
    rem_catchup_grace_minutes: 600,
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function() {
      return new Promise((resolve) => {
        resolveDream = resolve;
      });
    },
    write_report: false
  });

  await waitOneTurn();
  const dreaming = loadSleepCycleState({ state_file: stateFile });
  assert.equal(dreaming.rem_cycles[0].status, 'dreaming');
  assert.equal(dreaming.rem_cycles[0].dreaming_started_at, '2026-06-18T04:31:00.000Z');
  assert.equal(dreaming.rem_cycles[0].dreaming_process_pid, process.pid);
  assert.equal(dreaming.rem_cycles[0].last_transition_at, '2026-06-18T04:31:00.000Z');
  assert.equal(fs.readFileSync(eventsFile, 'utf8').includes('rem_dream_started'), true);

  resolveDream({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
    dream_txt_file: path.join(baseDir, 'dream-1.txt'),
    dream_metadata_file: path.join(baseDir, 'dream-1.json')
  });
  const tick = await pending;
  assert.equal(tick.ok, true);
  const complete = loadSleepCycleState({ state_file: stateFile });
  assert.equal(complete.rem_cycles[0].status, 'complete');
  assert.equal(complete.rem_cycles[0].dreaming_process_pid, null);
  assert.equal(complete.rem_cycles[0].completed_at, '2026-06-18T04:31:00.000Z');
  assert.equal(fs.readFileSync(eventsFile, 'utf8').includes('rem_dream_completed'), true);
}

async function runFailureCase(baseDir) {
  const stateFile = path.join(baseDir, 'failed-state.json');
  const eventsFile = path.join(baseDir, 'failed-events.jsonl');
  let propagated = false;
  await assert.rejects(runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: '2026-06-18T04:31:00.000Z',
    // Opt out of the truthful catch-up policy (see runCompletionCase).
    rem_catchup_grace_minutes: 600,
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function() {
      throw new Error('intentional dream failure');
    },
    write_report: false
  }).catch((error) => {
    propagated = true;
    throw error;
  }), /intentional dream failure/);
  assert.equal(propagated, true);

  const failedAttempt = loadSleepCycleState({ state_file: stateFile });
  const cycle = failedAttempt.rem_cycles[0];
  assert.notEqual(cycle.status, 'complete');
  assert.notEqual(cycle.status, 'failed');
  assert.equal(cycle.status, 'pending');
  assert.equal(cycle.dreaming_process_pid, null);
  assert.equal(cycle.dream_attempt_count, 1);
  assert.equal(cycle.last_attempt_error, 'intentional dream failure');
  assert.equal(failedAttempt.last_architecture_error, 'intentional dream failure');
  assert.equal(Object.prototype.hasOwnProperty.call(cycle, 'failure_message'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cycle, 'dream_txt_file') && cycle.dream_txt_file !== null, false);
  const events = fs.readFileSync(eventsFile, 'utf8');
  assert.equal(events.includes('rem_dream_architecture_error'), true);
  assert.equal(events.includes('rem_dream_failed'), false);
  assert.equal(events.includes('rem_dream_completed'), false);
}

async function run() {
  const unique = newId('durable_rem').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-cycle-durable-rem/' + unique);
  ensureDirSync(baseDir);

  await runCompletionCase(baseDir);
  await runFailureCase(baseDir);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_DURABLE_REM_STATE_PASS',
    dreaming_saved_before_dream_runner_resolved: true,
    successful_dream_completed: true,
    expected_exception_propagated: true,
    failed_attempt_requeued_pending: true,
    no_failed_rem_state: true,
    no_fallback_dream_fabricated: true,
    no_success_marker_for_failed_attempt: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_CYCLE_DURABLE_REM_STATE_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
