'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { statePath, ensureDirSync, writeJsonFileAtomicSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createSleepCycleState } = require('../src/chat/sleep-cycle.cjs');
const { buildFlokiLifecycleStatus } = require('../src/chat/floki-lifecycle-status.cjs');

function run() {
  const unique = newId('lifecycle_stale_rem').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/lifecycle-status-stale-rem/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  ensureDirSync(baseDir);

  const state = createSleepCycleState({ now: '2026-06-18T03:30:00.000Z' });
  writeJsonFileAtomicSync(stateFile, {
    ...state,
    rem_cycles: state.rem_cycles.map((cycle) => cycle.cycle_number === 2 ? {
      ...cycle,
      status: 'dreaming',
      dreaming_started_at: '2026-06-18T06:01:00.000Z',
      dreaming_process_pid: 999999,
      last_transition_at: '2026-06-18T06:01:00.000Z'
    } : cycle),
    last_transition_at: '2026-06-18T06:01:00.000Z'
  });

  const status = buildFlokiLifecycleStatus({
    now: '2026-06-18T06:02:00.000Z',
    state_file: stateFile,
    process_is_alive: () => false
  });

  assert.notEqual(status.state, 'rem_dreaming');
  assert.equal(status.state, 'asleep');
  assert.equal(status.display_label, 'ASLEEP');
  assert.equal(status.stale_dreaming_state_detected, true);
  assert.equal(status.stale_rem_cycle_number, 2);
  assert.equal(status.current_rem_process_alive, false);
  assert.equal(status.current_rem_cycle_number, null);
  assert.equal(status.source_of_truth, 'sleep_cycle_state');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIFECYCLE_STALE_REM_PROTECTION_PASS',
    stale_rem_cycle_number: status.stale_rem_cycle_number,
    reported_state: status.state,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_LIFECYCLE_STALE_REM_PROTECTION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
