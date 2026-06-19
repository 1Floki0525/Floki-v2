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

async function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'sleep-cycle.cjs'), 'utf8');
  const dreamStatusSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'dream-status.cjs'), 'utf8');
  assert.equal(source.includes('rem_dream_' + 'failed'), false);
  assert.equal(dreamStatusSource.includes("status === 'failed'"), false);
  assert.equal(dreamStatusSource.includes('rem_cycles_' + 'failed_tonight'), false);
  assert.equal(source.includes("status: 'failed'"), false);
  assert.equal(source.includes("countCycles(state, 'failed')"), false);
  assert.equal(source.includes('rem_dream_architecture_error'), true);

  const unique = newId('sleep_no_failed_state').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-no-failed-state/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  ensureDirSync(baseDir);

  await assert.rejects(
    runSleepCycleTick({
      env: {
        FLOKI_ALLOW_SLEEP_CYCLE: '1',
        FLOKI_ALLOW_DREAM_ENGINE: '1'
      },
      now: '2026-06-18T04:31:00.000Z',
      state_file: stateFile,
      events_file: eventsFile,
      write_report: false,
      dream_runner: async function() {
        throw new Error('contract architecture error');
      }
    }),
    /contract architecture error/
  );

  const state = loadSleepCycleState({ state_file: stateFile });
  assert.equal(state.rem_cycles[0].status, 'dreaming');
  assert.equal(state.rem_cycles[0].dreaming_process_pid, process.pid);
  assert.equal(Object.prototype.hasOwnProperty.call(state.rem_cycles[0], 'failure_message'), false);
  assert.equal(state.last_architecture_error, 'contract architecture error');

  const events = fs.readFileSync(eventsFile, 'utf8');
  assert.equal(events.includes('rem_dream_architecture_error'), true);
  assert.equal(events.includes('rem_dream_' + 'failed'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_NO_FAILED_STATE_PASS',
    failed_state_removed: true,
    architecture_error_stops_tick: true,
    rem_cycle_not_skipped: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_CYCLE_NO_FAILED_STATE_CONTRACT_ERROR',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
