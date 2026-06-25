'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  isRecoverableDreamQualityError,
  runSchedulerIteration
} = require(
  path.join(root, 'src/chat/sleep-cycle-scheduler.cjs')
);

async function main() {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-scheduler-repair-')
  );

  try {
    const error = new Error(
      'DREAM_QUALITY_CONTRACT_REJECTED_AFTER_2_ATTEMPTS: ' +
      'dream quality violations: dream opening is too similar to a recent dream'
    );

    assert.equal(
      isRecoverableDreamQualityError(error),
      true,
      'legacy quality error remains recoverable'
    );

    const legacyResult = await runSchedulerIteration({
      runtime_dir: runtimeDir,
      write_report: false,
      tick_runner: async () => {
        throw error;
      }
    });

    assert.equal(legacyResult.ok, true, 'legacy quality rejection must not crash scheduler');
    assert.equal(
      legacyResult.marker,
      'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_DREAM_REPAIR_QUEUED'
    );

    const result = await runSchedulerIteration({
      runtime_dir: runtimeDir,
      write_report: false,
      tick_runner: async () => ({
        ok: true,
        marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
        within_sleep_window: true,
        sleep_cycle_active: true,
        dreams_generated_this_tick: 0,
        rem_cycles_regenerating: 1
      })
    });

    assert.equal(result.ok, true, 'scheduler iteration must pass while a cycle is regenerating');
    assert.equal(result.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TICK_PASS');
    assert.equal(result.dreams_generated_this_tick, 0);

    const status = JSON.parse(
      fs.readFileSync(
        path.join(runtimeDir, 'sleep-cycle-scheduler.status.json'),
        'utf8'
      )
    );

    const heartbeat = JSON.parse(
      fs.readFileSync(
        path.join(runtimeDir, 'sleep-cycle-scheduler.heartbeat.json'),
        'utf8'
      )
    );

    assert.equal(status.marker, 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TICK_PASS');
    assert.equal(heartbeat.phase, 'idle');

    await assert.rejects(
      runSchedulerIteration({
        runtime_dir: runtimeDir,
        write_report: false,
        tick_runner: async () => {
          throw new Error('configuration architecture failure');
        }
      }),
      /configuration architecture failure/
    );

    console.log(JSON.stringify({
      ok: true,
      marker:
        'FLOKI_SLEEP_SCHEDULER_DREAM_REPAIR_QUEUE_SURVIVAL_PASS',
      rejected_dream_stored: false,
      quality_repair_queued: true,
      scheduler_crashes_on_quality_rejection: false,
      scheduler_survives_regenerating_cycle: true,
      architecture_errors_still_fatal: true,
      live_scheduler_started: false
    }, null, 2));
  } finally {
    fs.rmSync(runtimeDir, {
      recursive: true,
      force: true
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
