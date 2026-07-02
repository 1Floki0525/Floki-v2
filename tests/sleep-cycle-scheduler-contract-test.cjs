'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  SCHEDULER_TICK_MS,
  SCHEDULER_HEARTBEAT_STALE_MS,
  schedulerPaths,
  readSchedulerRuntimeStatus,
  runSchedulerIteration
} = require('../src/chat/sleep-cycle-scheduler.cjs');

async function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  assert.equal(SCHEDULER_TICK_MS, 30000);
  assert.equal(SCHEDULER_HEARTBEAT_STALE_MS, 90000);

  const unique = newId('sleep_scheduler').replace(/[^a-z0-9_]/g, '_');
  const runtimeDir = statePath('test/sleep-scheduler/' + unique);
  ensureDirSync(runtimeDir);
  const paths = schedulerPaths({ runtime_dir: runtimeDir });
  fs.writeFileSync(paths.pid_file, String(process.pid) + '\n');

  let tickCalls = 0;
  const iteration = await runSchedulerIteration({
    ...paths,
    runtime_dir: runtimeDir,
    write_report: false,
    tick_runner: async function(options) {
      tickCalls += 1;
      assert.equal(options.env.FLOKI_ALLOW_SLEEP_CYCLE, '1');
      assert.equal(options.env.FLOKI_ALLOW_DREAM_ENGINE, '1');
      return {
        ok: true,
        marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
        within_sleep_window: true,
        sleep_cycle_active: true,
        dreams_generated_this_tick: 0
      };
    }
  });

  assert.equal(iteration.ok, true);
  assert.equal(iteration.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TICK_PASS');
  assert.equal(tickCalls, 1);
  assert.equal(fs.existsSync(paths.heartbeat_file), true);
  assert.equal(fs.existsSync(paths.status_file), true);

  const active = readSchedulerRuntimeStatus({
    ...paths,
    runtime_dir: runtimeDir,
    process_is_alive: (pid) => pid === process.pid,
    now: new Date()
  });
  assert.equal(active.ok, true);
  assert.equal(active.active, true);
  assert.equal(active.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_ACTIVE');

  fs.rmSync(paths.pid_file, { force: true });
  const inactive = readSchedulerRuntimeStatus({
    ...paths,
    runtime_dir: runtimeDir,
    process_is_alive: () => false,
    now: new Date()
  });
  assert.equal(inactive.ok, true);
  assert.equal(inactive.active, false);
  assert.equal(inactive.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_INACTIVE');

  await assert.rejects(
    runSchedulerIteration({
      ...paths,
      runtime_dir: runtimeDir,
      write_report: false,
      tick_runner: async function() {
        throw new Error('fatal dream architecture error');
      }
    }),
    /fatal dream architecture error/
  );
  const fatal = readSchedulerRuntimeStatus({
    ...paths,
    runtime_dir: runtimeDir,
    process_is_alive: (pid) => pid === process.pid,
    now: new Date()
  });
  assert.equal(fatal.last_status.ok, false);
  assert.equal(fatal.last_status.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_FATAL_ARCHITECTURE_ERROR');
  assert.equal(fatal.last_status.fatal_architecture_error, true);
  assert.equal(fatal.last_status.error, 'fatal dream architecture error');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_CONTRACT_PASS',
    serial_tick_execution: true,
    sleep_and_dream_guards_enabled: true,
    active_and_inactive_status_verified: true,
    fatal_architecture_error_reported: true,
    node_24_required: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_CONTRACT_ERROR',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
