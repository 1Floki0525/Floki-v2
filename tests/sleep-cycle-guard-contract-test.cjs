'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  sleepCycleGuardStatus,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');

async function run() {
  const unique = newId('sleep_cycle_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-cycle-guard/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  ensureDirSync(baseDir);

  const guard = sleepCycleGuardStatus({});
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.sleep_cycle_run_now, false);
  assert.equal(guard.dream_generation_run_now, false);
  assert.equal(guard.cold_storage_write_now, false);

  let dreamCalls = 0;
  const proof = await runSleepCycleTick({
    env: {},
    now: '2026-06-18T04:31:00.000Z',
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function() {
      dreamCalls += 1;
      return {};
    },
    write_report: false
  });

  assert.equal(proof.ok, false);
  assert.equal(proof.marker, 'FLOKI_V2_SLEEP_CYCLE_BLOCKED');
  assert.equal(proof.sleep_cycle_active, false);
  assert.equal(proof.dreams_generated_this_tick, 0);
  assert.equal(dreamCalls, 0);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.existsSync(eventsFile), false);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_GUARD_CONTRACT_PASS',
    no_dream_generation: dreamCalls === 0,
    no_state_write: fs.existsSync(stateFile) === false,
    no_cold_storage_writes: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_CYCLE_GUARD_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
