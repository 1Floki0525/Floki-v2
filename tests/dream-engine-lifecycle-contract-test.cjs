'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readDreamEngineControl,
  writeDreamEngineControl
} = require('../src/chat/dream-engine-control.cjs');
const {
  loadSleepCycleState,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');
const {
  beginManualNap,
  claimDueRemCycle,
  readManualNapState
} = require('../src/chat/manual-nap.cjs');
const {
  SUPERVISED_MODULES,
  IN_PROCESS_MODULES,
  getModuleConfig
} = require('../src/control-plane/module-registry.cjs');
const {
  MODULE_TO_SCRIPTS,
  MODULE_TO_STATUS_COMMAND
} = require('../src/control-plane/floki-control-supervisor.cjs');

async function run() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-dream-lifecycle-')
  );
  const runtimeDir = path.join(tempRoot, 'runtime');
  const stateFile = path.join(
    tempRoot,
    'sleep-cycle-state.json'
  );
  const eventsFile = path.join(
    tempRoot,
    'sleep-events.jsonl'
  );
  const reportFile = path.join(
    tempRoot,
    'sleep-report.json'
  );
  const napStateFile = path.join(
    tempRoot,
    'manual-nap-state.json'
  );

  try {
    // 1. Default control state is enabled at generation zero.
    const initial = readDreamEngineControl({
      runtime_dir: runtimeDir
    });
    assert.equal(initial.enabled, true);
    assert.equal(initial.generation, 0);
    assert.equal(initial.reason, 'default_enabled');

    // 2 + 3. Stop, Start, and Reset persist atomically and each
    // write strictly increases the control generation.
    const stopped = writeDreamEngineControl(false, {
      runtime_dir: runtimeDir,
      reason: 'test_stop'
    });
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.generation, 1);
    const stoppedRead = readDreamEngineControl({
      runtime_dir: runtimeDir
    });
    assert.equal(stoppedRead.enabled, false);
    assert.equal(stoppedRead.generation, 1);

    const started = writeDreamEngineControl(true, {
      runtime_dir: runtimeDir,
      reason: 'test_start'
    });
    assert.equal(started.enabled, true);
    assert.equal(started.generation, 2);
    assert.equal(
      readDreamEngineControl({
        runtime_dir: runtimeDir
      }).enabled,
      true
    );

    const reset = writeDreamEngineControl(true, {
      runtime_dir: runtimeDir,
      reason: 'test_reset'
    });
    assert.equal(reset.enabled, true);
    assert.equal(reset.generation, 3);
    const resetRead = readDreamEngineControl({
      runtime_dir: runtimeDir
    });
    assert.equal(resetRead.enabled, true);
    assert.equal(resetRead.generation, 3);

    // 4-6 + 8. While disabled, a due nightly REM cycle remains
    // pending, the dream runner is never called, pre-REM work is
    // not run, and no dream files are written.
    let dreamRunnerCalls = 0;
    let preRemCalls = 0;

    const result = await runSleepCycleTick({
      now: new Date('2026-01-02T05:25:00.000Z'),
      state_file: stateFile,
      events_file: eventsFile,
      report_file: reportFile,
      write_report: true,
      env: {
        FLOKI_ALLOW_SLEEP_CYCLE: '1',
        FLOKI_ALLOW_DREAM_ENGINE: '0'
      },
      dream_engine_control: {
        enabled: false,
        reason: 'isolated_test_stop',
        control_file:
          path.join(runtimeDir, 'dream-engine-control.json')
      },
      pre_rem_memory_preparation_runner: async () => {
        preRemCalls += 1;
        throw new Error(
          'pre-REM work must not run while Dream Engine is stopped'
        );
      },
      dream_runner: async () => {
        dreamRunnerCalls += 1;
        throw new Error(
          'dream runner must not run while Dream Engine is stopped'
        );
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.dream_engine_enabled, false);
    assert.equal(result.dream_generation_suspended, true);
    assert.equal(result.dreams_generated_this_tick, 0);
    assert.equal(result.dream_files_written.length, 0);
    assert.equal(dreamRunnerCalls, 0);
    assert.equal(preRemCalls, 0);

    const state = loadSleepCycleState({
      state_file: stateFile
    });
    assert.ok(state);
    assert.ok(
      state.rem_cycles.some(
        (cycle) => cycle.status === 'pending'
      )
    );
    assert.equal(
      state.rem_cycles.some(
        (cycle) => cycle.status === 'failed'
      ),
      false
    );
    assert.equal(
      state.rem_cycles.some(
        (cycle) => cycle.status === 'complete'
      ),
      false
    );

    // 7. A due manual-nap REM cycle is not claimed while the
    // Dream Engine is disabled, and stays pending.
    const napBegunAt = new Date('2026-01-02T05:00:00.000Z');
    const nap = beginManualNap({
      state_file: napStateFile,
      now: napBegunAt
    });
    assert.equal(nap.active, true);
    assert.ok(nap.rem_cycles.length > 0);
    const dueAt = new Date(
      new Date(nap.rem_cycles[0].scheduled_at).getTime() + 1000
    );
    assert.ok(dueAt < new Date(nap.wake_at));

    const blockedClaim = claimDueRemCycle({
      state_file: napStateFile,
      now: dueAt,
      dream_engine_control: {
        enabled: false,
        reason: 'isolated_test_stop'
      }
    });
    assert.equal(blockedClaim, null);
    const napAfterBlocked = readManualNapState({
      state_file: napStateFile,
      now: dueAt
    });
    assert.equal(
      napAfterBlocked.rem_cycles[0].status,
      'pending'
    );

    const allowedClaim = claimDueRemCycle({
      state_file: napStateFile,
      now: dueAt,
      dream_engine_control: {
        enabled: true,
        reason: 'isolated_test_start'
      }
    });
    assert.ok(allowedClaim);
    assert.equal(allowedClaim.cycle.status, 'dreaming');

    // 9. Sleep Scheduler remains an independent supervised module;
    // Dream Engine is an in-process module.
    assert.equal(SUPERVISED_MODULES.has('sleep_scheduler'), true);
    assert.equal(SUPERVISED_MODULES.has('dream_engine'), false);
    assert.equal(IN_PROCESS_MODULES.has('dream_engine'), true);

    // The Dream Engine status card is based on the authoritative
    // control record, including a genuine degraded path.
    const statusSource =
      getModuleConfig('dream_engine').status_source;
    assert.equal(
      statusSource({ dreamEngineControl: { enabled: true } }),
      'running'
    );
    assert.equal(
      statusSource({ dreamEngineControl: { enabled: false } }),
      'stopped'
    );
    assert.equal(
      statusSource({
        dreamEngineControl: {
          enabled: true,
          read_error: 'corrupt control record'
        }
      }),
      'degraded'
    );

    // 10. Dream Engine does not appear in supervisor script
    // mappings.
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        MODULE_TO_SCRIPTS,
        'dream_engine'
      ),
      false
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        MODULE_TO_STATUS_COMMAND,
        'dream_engine'
      ),
      false
    );

    console.log(JSON.stringify({
      ok: true,
      marker:
        'FLOKI_V2_DREAM_ENGINE_LIFECYCLE_CONTRACT_PASS',
      default_enabled: true,
      persistent_control_roundtrip: true,
      generation_monotonic: true,
      stopped_due_rem_remains_pending: true,
      dream_runner_calls_while_stopped: dreamRunnerCalls,
      pre_rem_calls_while_stopped: preRemCalls,
      manual_nap_claim_blocked_while_stopped: true,
      dream_files_written: result.dream_files_written,
      sleep_scheduler_independent: true,
      dream_engine_supervisor_alias_absent: true,
      sleep_scheduler_process_started: false,
      real_dream_generated: false
    }, null, 2));
  } finally {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true
    });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker:
      'FLOKI_V2_DREAM_ENGINE_LIFECYCLE_CONTRACT_FAIL',
    error: error.message,
    stack: error.stack
  }, null, 2));
  process.exitCode = 1;
});
