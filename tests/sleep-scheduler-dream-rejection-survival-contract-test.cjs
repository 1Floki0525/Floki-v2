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
    path.join(os.tmpdir(), 'floki-scheduler-rejection-')
  );

  try {
    const error = new Error(
      'DREAM_QUALITY_CONTRACT_REJECTED_AFTER_2_ATTEMPTS: ' +
      'dream quality violations: dream opening is too similar to a recent dream'
    );

    assert.equal(
      isRecoverableDreamQualityError(error),
      true
    );

    const result = await runSchedulerIteration({
      runtime_dir: runtimeDir,
      write_report: false,
      tick_runner: async () => {
        throw error;
      }
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.marker,
      'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_DREAM_REJECTED'
    );
    assert.equal(result.degraded, true);
    assert.equal(result.dream_generated, false);

    const status = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeDir,
          'sleep-cycle-scheduler.status.json'
        ),
        'utf8'
      )
    );

    const heartbeat = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeDir,
          'sleep-cycle-scheduler.heartbeat.json'
        ),
        'utf8'
      )
    );

    assert.equal(status.dream_generated, false);
    assert.equal(
      heartbeat.phase,
      'idle_after_dream_rejection'
    );

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
        'FLOKI_SLEEP_SCHEDULER_DREAM_REJECTION_SURVIVAL_PASS',
      rejected_dream_stored: false,
      scheduler_crashes_on_quality_rejection: false,
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
