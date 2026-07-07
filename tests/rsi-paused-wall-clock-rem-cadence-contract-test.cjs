'use strict';

// Paused-RSI wall-clock REM cadence contract.
//
// Proves, on the REAL production sleep tick + nightly coordinator driven by
// the daytime night-cycle simulation harness (isolated state, virtual clock):
// - RSI paused during sleep => rem_mode 'wall_clock' every tick;
// - the schedule holds 47 opportunities at offsets +10..+470 minutes;
// - no training session and no candidate are ever created;
// - at most one dream dispatches per tick (rem_max_dispatch_per_tick);
// - never-attempted cycles older than the catch-up grace are truthfully
//   marked 'missed' instead of flooding backlog dreams;
// - production sleep state on disk is untouched by the simulation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNightCycleSimulation,
  runPausedSimulation
} = require('../src/chat/night-cycle-simulation.cjs');
const { statePath } = require('../src/util/fs-safe.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-night-sim-paused-'));
  const productionSleepState = statePath('chat/sleep/sleep-cycle-state.json');
  const productionBefore = fs.existsSync(productionSleepState)
    ? fs.statSync(productionSleepState).mtimeMs
    : null;

  const dreamFiles = [];
  const sim = createNightCycleSimulation({
    root,
    publish_latest: false,
    dream_runner: async (options) => {
      const file = path.join(
        root, 'dreams',
        'dream-cycle-' + String(options.rem_cycle_number) + '.txt'
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'real simulated-night dispatch for cycle ' +
        String(options.rem_cycle_number) + '\n');
      dreamFiles.push(file);
      return Object.freeze({ ok: true, dream_txt_file: file, dream_metadata_file: null });
    }
  });

  assert.equal(sim.sleep_window.start_hhmm, '23:00',
    'production YAML sleep start must stay 23:00');
  assert.equal(sim.sleep_window.end_hhmm, '07:00',
    'production YAML sleep end must stay 07:00');

  const { ticks, proof } = await runPausedSimulation({ simulation: sim, dreams: 2 });

  assert.equal(proof.ok, true, 'paused simulation must pass: ' + JSON.stringify(proof, null, 2));
  for (const tick of ticks) {
    assert.equal(tick.rem_mode, 'wall_clock', 'RSI paused ticks must run wall-clock REM');
    assert.equal(tick.rsi_paused, true);
    assert.ok(Number(tick.dreams_generated_this_tick || 0) <= 1,
      'at most one dream may dispatch per tick, got ' + tick.dreams_generated_this_tick);
    assert.equal(tick.nightly_training_enabled, true,
      'coordinator stays attached while paused (dream engine independent of RSI pause)');
  }

  const state = JSON.parse(fs.readFileSync(sim.sleep_paths.state_file, 'utf8'));
  assert.equal(state.rem_cycles.length, 47, 'a full night holds 47 REM opportunities');
  assert.equal(state.rem_trigger, 'fixed_schedule');
  const windowStartMs = new Date(sim.sleep_window.start_at).getTime();
  state.rem_cycles.forEach((cycle, index) => {
    const offsetMinutes = (new Date(cycle.scheduled_at).getTime() - windowStartMs) / 60000;
    assert.equal(offsetMinutes, (index + 1) * 10,
      'cycle ' + String(index + 1) + ' must sit at +' + String((index + 1) * 10) + ' minutes');
  });

  const statuses = state.rem_cycles.map((cycle) => cycle.status);
  assert.equal(statuses.filter((s) => s === 'complete').length, 3,
    'dreams 1, 2 and the post-gap due cycle must be complete');
  assert.equal(statuses.filter((s) => s === 'missed').length, 2,
    'the two never-attempted skipped slots must be truthfully missed, not flooded');
  assert.equal(statuses.filter((s) => s === 'pending').length, 42);
  assert.equal(dreamFiles.length, 3, 'exactly three real dream dispatches happened');
  for (const file of dreamFiles) assert.ok(fs.existsSync(file));

  const missed = state.rem_cycles.filter((cycle) => cycle.status === 'missed');
  for (const cycle of missed) {
    assert.equal(cycle.missed_reason, 'scheduler_unavailable_within_catchup_grace');
    assert.ok(cycle.missed_at, 'missed cycles must be timestamped');
  }
  const eventLines = fs.readFileSync(sim.sleep_paths.events_file, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(
    eventLines.filter((event) => event.type === 'rem_cycle_missed').length, 2,
    'missed cycles must be user-visible in the sleep event log'
  );

  // No training and no candidate while paused.
  assert.equal(proof.training_session_created, false);
  assert.equal(proof.candidates, 0);
  assert.equal(fs.existsSync(sim.config.gpu_ownership_lock_file), false,
    'paused nights must never take the GPU training lock');

  // Production night state untouched.
  const productionAfter = fs.existsSync(productionSleepState)
    ? fs.statSync(productionSleepState).mtimeMs
    : null;
  assert.equal(productionAfter, productionBefore,
    'the simulation must never write the production sleep state');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_PAUSED_WALL_CLOCK_REM_CADENCE_CONTRACT_PASS',
    cycles_total: state.rem_cycles.length,
    dreams_dispatched: dreamFiles.length,
    missed: statuses.filter((s) => s === 'missed').length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
