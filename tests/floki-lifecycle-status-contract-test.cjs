'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { statePath, ensureDirSync, writeJsonFileAtomicSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  createSleepCycleState,
  markAwakeInterruption
} = require('../src/chat/sleep-cycle.cjs');
const {
  buildFlokiLifecycleStatus,
  formatLifecycleHumanSummary
} = require('../src/chat/floki-lifecycle-status.cjs');

function fixturePath(label) {
  const unique = newId(label).replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/lifecycle-status/' + unique);
  ensureDirSync(baseDir);
  return path.join(baseDir, 'sleep-cycle-state.json');
}

function writeState(filePath, state) {
  writeJsonFileAtomicSync(filePath, state);
}

function run() {
  const outside = buildFlokiLifecycleStatus({
    now: '2026-06-18T16:00:00.000Z',
    state_file: fixturePath('outside')
  });
  assert.equal(outside.marker, 'FLOKI_V2_LIFECYCLE_STATUS_PASS');
  assert.equal(outside.state, 'awake');
  assert.equal(outside.display_label, 'AWAKE');
  assert.equal(outside.is_awake, true);
  assert.equal(outside.is_asleep, false);
  assert.equal(outside.is_rem_dreaming, false);

  const asleepStateFile = fixturePath('asleep');
  writeState(asleepStateFile, createSleepCycleState({ now: '2026-06-18T04:00:00.000Z' }));
  const asleep = buildFlokiLifecycleStatus({
    now: '2026-06-18T04:10:00.000Z',
    state_file: asleepStateFile
  });
  assert.equal(asleep.state, 'asleep');
  assert.equal(asleep.display_label, 'ASLEEP');
  assert.equal(asleep.is_asleep, true);
  assert.equal(asleep.sleep_cycle_state_loaded, true);

  const interruptedStateFile = fixturePath('interrupted');
  const interrupted = markAwakeInterruption(
    createSleepCycleState({ now: '2026-06-18T04:00:00.000Z' }),
    'typed_chat_activity',
    { now: '2026-06-18T04:05:00.000Z', write_event: false }
  );
  writeState(interruptedStateFile, interrupted);
  const interruptedStatus = buildFlokiLifecycleStatus({
    now: '2026-06-18T04:06:00.000Z',
    state_file: interruptedStateFile
  });
  assert.equal(interruptedStatus.state, 'awake_sleep_interrupted');
  assert.equal(interruptedStatus.display_label, 'AWAKE — SLEEP INTERRUPTED');
  assert.equal(interruptedStatus.sleep_interrupted, true);
  assert.equal(interruptedStatus.is_awake, true);

  const remStateFile = fixturePath('rem');
  const remState = createSleepCycleState({ now: '2026-06-18T03:30:00.000Z' });
  writeState(remStateFile, {
    ...remState,
    rem_cycles: remState.rem_cycles.map((cycle) => cycle.cycle_number === 1 ? {
      ...cycle,
      status: 'dreaming',
      dreaming_started_at: '2026-06-18T04:31:00.000Z',
      dreaming_process_pid: 4242,
      last_transition_at: '2026-06-18T04:31:00.000Z'
    } : cycle),
    last_transition_at: '2026-06-18T04:31:00.000Z'
  });
  const rem = buildFlokiLifecycleStatus({
    now: '2026-06-18T04:32:00.000Z',
    state_file: remStateFile,
    process_is_alive: (pid) => pid === 4242
  });
  assert.equal(rem.state, 'rem_dreaming');
  assert.equal(rem.display_label, 'REM DREAMING');
  assert.equal(rem.is_rem_dreaming, true);
  assert.equal(rem.current_rem_cycle_number, 1);
  assert.equal(rem.current_rem_process_alive, true);

  const human = formatLifecycleHumanSummary(rem);
  assert.equal(human.includes('dream body text'), false);
  assert.equal(human.includes('private_reasoning'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIFECYCLE_STATUS_PASS',
    states_verified: ['awake', 'asleep', 'awake_sleep_interrupted', 'rem_dreaming'],
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_LIFECYCLE_STATUS_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
