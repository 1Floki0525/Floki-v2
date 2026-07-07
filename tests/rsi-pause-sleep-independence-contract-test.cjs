'use strict';

// Contract: the RSI pause sentinel and nightly training failures must never
// pause, gate, or starve the sleep scheduler or the dream engine.
//
// MODE A (RSI paused): training never starts, held training resources are
// released, and REM returns to the fixed 10-minute wall-clock schedule.
// MODE B (nighttime RSI enabled): REM stays epoch-triggered only while the
// nightly session is healthy; a terminal training failure hands REM back to
// the wall-clock schedule instead of blocking dreams for the night, and the
// persisted failure latch survives the resource-restoration path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNightlyTrainingCoordinator
} = require('../src/self-improvement/training/training-scheduler.cjs');
const {
  resolveNightlyRestorePolicy
} = require('../src/self-improvement/training/runtime-resource-controller.cjs');
const {
  runSchedulerIteration,
  schedulerPaths
} = require('../src/chat/sleep-cycle-scheduler.cjs');
const {
  createSleepCycleState,
  reconcileRemSchedule,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');

const SLEEP_WINDOW = Object.freeze({
  timezone: 'America/Toronto',
  sleep_date: '2026-07-04',
  start_hhmm: '23:00',
  end_hhmm: '07:00',
  start_at: '2026-07-05T03:00:00.000Z',
  end_at: '2026-07-05T11:00:00.000Z',
  crosses_midnight: true
});
const NIGHT_NOW = new Date('2026-07-05T05:00:00.000Z');

function buildCoordinatorFixture(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pause-indep-'));
  const calls = [];
  let stored = Object.prototype.hasOwnProperty.call(overrides, 'session')
    ? overrides.session
    : null;
  let gpuOwner = overrides.gpu_owner || null;
  const config = {
    training_enabled: true,
    nightly_training_enabled: true,
    nightly_training_provider: 'huggingface',
    nightly_rem_provider: 'huggingface',
    nightly_training_run_id_prefix: 'nightly-training',
    training_rem_claim_file: path.join(tempDir, 'rem-claims.json'),
    ...overrides.config
  };
  const coordinator = createNightlyTrainingCoordinator({
    config,
    gpu: {
      currentOwner: () => gpuOwner,
      readOwner: () => ({ owner: gpuOwner }),
      acquire: (owner, detail) => {
        calls.push(['gpu_acquire', owner]);
        gpuOwner = owner;
        return { owner };
      },
      transfer: (from, to) => {
        calls.push(['gpu_transfer', from, to]);
        gpuOwner = to;
        return { owner: to };
      },
      release: (owner) => {
        calls.push(['gpu_release', owner]);
        gpuOwner = null;
      }
    },
    enter_resource: async (runId) => {
      calls.push(['enter_resource', runId]);
      return { ok: true };
    },
    exit_resource: async (reason) => {
      calls.push(['exit_resource', reason]);
      return { ok: true, result: { ok: true, released_gpu: true } };
    },
    create_session: overrides.create_session || (() => {
      throw new Error('create_session must not run in this scenario');
    }),
    read_session: () => stored,
    refresh_session: (session) => session,
    write_session: (session) => {
      stored = session;
      return session;
    },
    set_resource_entered: (session, entered) => {
      stored = { ...session, resource_entered: entered === true };
      return stored;
    },
    start_segment: overrides.start_segment || (async () => {
      throw new Error('start_segment must not run in this scenario');
    }),
    checkpoint_session: async (session, options) => {
      calls.push(['checkpoint', options && options.reason]);
      return { ok: true, session };
    },
    finalize_session: overrides.finalize_session || ((session) => {
      calls.push(['finalize']);
      return { ...session, finalized: true };
    }),
    force_container: () => ({ ok: true }),
    mark_training_error: (session) => session,
    get_sleep_window: () => SLEEP_WINDOW,
    is_within_sleep_window: overrides.is_within_sleep_window || (() => true),
    read_manual_nap: () => ({ active: false }),
    read_sleep_state: () => null,
    run_dream_engine: overrides.run_dream_engine || (async () => {
      throw new Error('dream engine must not run in this scenario');
    }),
    run_hf_generation: async () => {
      throw new Error('hf generation must not run in this scenario');
    },
    load_config: () => config,
    audit: (type, detail) => calls.push(['audit', type]),
    status: (patch) => calls.push(['status', patch.phase || patch.state]),
    read_status: overrides.read_status || (() => ({ paused: false })),
    observe_training_reality: () => ({
      live_training: false,
      phase: 'starting',
      resource_mode: 'active',
      observed_gpu_owner: gpuOwner
    })
  });
  return {
    coordinator,
    calls,
    config,
    tempDir,
    session: () => stored,
    setSession: (value) => { stored = value; },
    gpuOwner: () => gpuOwner,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true })
  };
}

async function scenarioPausedWithoutSession() {
  const fixture = buildCoordinatorFixture({ session: null });
  try {
    const result = await fixture.coordinator.reconcile({
      now: NIGHT_NOW,
      rsi_paused: true
    });
    assert.equal(result.action, 'rsi_paused_wall_clock_rem');
    assert.equal(
      fixture.calls.some(([kind]) => kind === 'enter_resource'),
      false,
      'RSI pause must not enter the training resource mode'
    );
    assert.equal(
      fixture.calls.some(([kind]) => kind === 'gpu_acquire'),
      false,
      'RSI pause must not acquire the GPU'
    );
    assert.equal(fixture.session(), null, 'no nightly session may be created while paused');
    assert.equal(
      fixture.coordinator.remMode({ now: NIGHT_NOW, rsi_paused: true }),
      'wall_clock',
      'paused RSI must hand REM to the wall-clock schedule'
    );
  } finally {
    fixture.cleanup();
  }
}

async function scenarioPausedReleasesHeldResources() {
  const fixture = buildCoordinatorFixture({
    session: {
      run_id: 'nightly-training-2026-07-04-test',
      sleep_date: SLEEP_WINDOW.sleep_date,
      active: true,
      finalized: false,
      resource_entered: true,
      current_container: null,
      completed_epochs: 0,
      rem_cycles_completed: 0
    },
    gpu_owner: 'hf_training'
  });
  try {
    const result = await fixture.coordinator.reconcile({
      now: NIGHT_NOW,
      rsi_paused: true
    });
    assert.equal(result.action, 'rsi_paused_wall_clock_rem');
    const exit = fixture.calls.find(([kind]) => kind === 'exit_resource');
    assert.ok(exit, 'held training resources must be released on RSI pause');
    assert.equal(exit[1], 'rsi_paused_wall_clock_rem');
    assert.equal(fixture.session().status, 'paused_for_rsi_pause');
    assert.equal(fixture.session().resource_entered, false);
    assert.equal(
      fixture.calls.some(([, phase]) => phase === 'nightly_training_paused_for_rsi_pause'),
      true,
      'status must truthfully report the RSI pause handoff'
    );
  } finally {
    fixture.cleanup();
  }
}

async function scenarioPauseSentinelReadFromStatus() {
  // Without an explicit context flag, the coordinator must derive the pause
  // state from the canonical pause sentinel file itself.
  const sentinelDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-pause-sentinel-')
  );
  const fixture = buildCoordinatorFixture({
    session: null,
    config: {
      runtime_root: sentinelDir,
      pause_file_name: 'paused'
    }
  });
  try {
    fs.writeFileSync(path.join(sentinelDir, 'paused'), 'maker paused\n');
    const paused = await fixture.coordinator.reconcile({ now: NIGHT_NOW });
    assert.equal(paused.action, 'rsi_paused_wall_clock_rem');
    assert.equal(fixture.coordinator.remMode({ now: NIGHT_NOW }), 'wall_clock');

    fs.rmSync(path.join(sentinelDir, 'paused'), { force: true });
    assert.equal(
      fixture.coordinator.remMode({ now: NIGHT_NOW }),
      'epoch_triggered',
      'removing the sentinel must restore epoch-triggered REM without a restart'
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
}

async function scenarioTrainingFailureFallsBackToWallClock() {
  const fixture = buildCoordinatorFixture({
    session: {
      run_id: 'nightly-training-2026-07-04-test',
      sleep_date: SLEEP_WINDOW.sleep_date,
      active: true,
      finalized: false,
      resource_entered: true,
      current_container: null,
      training_failed: true,
      training_error: 'nightly training segment launch failed: cdi',
      completed_epochs: 0,
      rem_cycles_completed: 0
    },
    gpu_owner: 'hf_training'
  });
  try {
    const result = await fixture.coordinator.reconcile({
      now: NIGHT_NOW,
      rsi_paused: false
    });
    assert.equal(result.action, 'nightly_training_failed_wall_clock_rem');
    const exit = fixture.calls.find(([kind]) => kind === 'exit_resource');
    assert.ok(exit, 'failed training must release the training resources');
    assert.equal(exit[1], 'nightly_training_failed_wall_clock_rem');
    assert.equal(
      fixture.calls.some(
        ([, phase]) => phase === 'nightly_training_failed_wall_clock_rem_active'
      ),
      true,
      'the surfaced status must report the wall-clock fallback'
    );
    assert.equal(
      fixture.session().training_failed,
      true,
      'the failure latch must survive the fallback'
    );
    assert.equal(
      fixture.coordinator.remMode({ now: NIGHT_NOW, rsi_paused: false }),
      'wall_clock',
      'a terminally failed night must hand REM to the wall-clock schedule'
    );
  } finally {
    fixture.cleanup();
  }
}

async function scenarioLaunchFailureLatchSurvivesRestore() {
  // Reproduces the production defect: startSegment persists
  // training_failed=true and throws; the coordinator's recovery path used to
  // restore a stale pre-failure session, erasing the latch and relaunching
  // the failing container every tick for the whole night.
  const fixture = buildCoordinatorFixture({
    session: {
      run_id: 'nightly-training-2026-07-04-test',
      sleep_date: SLEEP_WINDOW.sleep_date,
      active: true,
      finalized: false,
      resource_entered: false,
      current_container: null,
      training_failed: false,
      completed_epochs: 0,
      rem_cycles_completed: 0
    }
  });
  fixture.setSession({ ...fixture.session() });
  const failingFixture = buildCoordinatorFixture({
    session: { ...fixture.session() }
  });
  fixture.cleanup();
  try {
    const coordinator = createNightlyTrainingCoordinator({
      config: failingFixture.config,
      gpu: {
        currentOwner: () => null,
        readOwner: () => ({ owner: null }),
        acquire: () => ({}),
        transfer: () => ({}),
        release: () => {}
      },
      enter_resource: async () => ({ ok: true }),
      exit_resource: async (reason) => {
        failingFixture.calls.push(['exit_resource', reason]);
        return { ok: true };
      },
      create_session: () => {
        throw new Error('create_session must not run');
      },
      read_session: () => failingFixture.session(),
      refresh_session: (session) => session,
      write_session: (session) => {
        failingFixture.setSession(session);
        return session;
      },
      set_resource_entered: (session, entered) => {
        const next = { ...session, resource_entered: entered === true };
        failingFixture.setSession(next);
        return next;
      },
      start_segment: async (session) => {
        // Mirror production startNightlyTrainingSegment: it persists the
        // failure latch before throwing.
        failingFixture.setSession({
          ...session,
          status: 'failed',
          current_container: null,
          training_failed: true,
          training_error: 'nightly training segment launch failed: cdi'
        });
        throw new Error('nightly training segment launch failed: cdi');
      },
      checkpoint_session: async (session) => ({ ok: true, session }),
      finalize_session: (session) => session,
      force_container: () => ({ ok: true }),
      mark_training_error: (session) => session,
      get_sleep_window: () => SLEEP_WINDOW,
      is_within_sleep_window: () => true,
      read_manual_nap: () => ({ active: false }),
      read_sleep_state: () => null,
      run_dream_engine: async () => {
        throw new Error('dream engine must not run');
      },
      run_hf_generation: async () => {
        throw new Error('hf generation must not run');
      },
      load_config: () => failingFixture.config,
      audit: () => {},
      status: () => {},
      read_status: () => ({ paused: false }),
      observe_training_reality: () => ({
        live_training: false,
        phase: 'starting',
        resource_mode: 'active',
        observed_gpu_owner: null
      })
    });

    await assert.rejects(
      coordinator.reconcile({ now: NIGHT_NOW, rsi_paused: false }),
      /nightly training segment launch failed/
    );
    assert.equal(
      failingFixture.session().training_failed,
      true,
      'the persisted failure latch must not be clobbered by resource restoration'
    );
    assert.equal(
      failingFixture.session().resource_entered,
      false,
      'training resources must be released after the launch failure'
    );
    assert.equal(
      coordinator.remMode({ now: NIGHT_NOW, rsi_paused: false }),
      'wall_clock',
      'after a latched launch failure REM must return to the wall-clock schedule'
    );
  } finally {
    failingFixture.cleanup();
  }
}

async function scenarioHealthyNightKeepsEpochTriggeredRem() {
  const fixture = buildCoordinatorFixture({
    session: {
      run_id: 'nightly-training-2026-07-04-test',
      sleep_date: SLEEP_WINDOW.sleep_date,
      active: true,
      finalized: false,
      resource_entered: true,
      current_container: 'floki-rsi-training-test-s1',
      training_failed: false,
      completed_epochs: 0,
      rem_cycles_completed: 0
    }
  });
  try {
    assert.equal(
      fixture.coordinator.remMode({ now: NIGHT_NOW, rsi_paused: false }),
      'epoch_triggered',
      'a healthy enabled night must keep epoch-triggered REM'
    );
  } finally {
    fixture.cleanup();
  }
}

async function scenarioSchedulerWiresRemModeIntoTick() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pause-sched-'));
  try {
    const paths = schedulerPaths({ runtime_dir: tempDir });
    const observed = [];
    const makeCoordinator = (mode) => ({
      beforeTick: async (context) => {
        observed.push(['before', context.rsi_paused]);
      },
      afterTick: async (context) => {
        observed.push(['after', context.rsi_paused]);
      },
      remMode: (context) => {
        observed.push(['remMode', context.rsi_paused]);
        return mode;
      },
      runNightlyRem: async () => {
        throw new Error('runNightlyRem must only be wired in epoch mode');
      }
    });

    const wallClockTick = await runSchedulerIteration({
      ...paths,
      runtime_dir: tempDir,
      write_report: false,
      rsi_paused: true,
      training_coordinator: makeCoordinator('wall_clock'),
      tick_runner: async (options) => {
        assert.equal(
          options.nightly_epoch_triggered_rem,
          false,
          'paused RSI must run the tick on the wall-clock REM schedule'
        );
        assert.equal(
          options.dream_runner,
          undefined,
          'the coordinator dream runner must not own wall-clock REM'
        );
        return {
          ok: true,
          marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
          within_sleep_window: true,
          sleep_cycle_active: true,
          dreams_generated_this_tick: 1
        };
      }
    });
    assert.equal(wallClockTick.rem_mode, 'wall_clock');
    assert.equal(wallClockTick.rsi_paused, true);
    assert.deepEqual(observed[0], ['before', true]);
    assert.equal(
      observed.some(([kind, paused]) => kind === 'remMode' && paused === true),
      true
    );

    const epochTick = await runSchedulerIteration({
      ...paths,
      runtime_dir: tempDir,
      write_report: false,
      rsi_paused: false,
      training_coordinator: makeCoordinator('epoch_triggered'),
      tick_runner: async (options) => {
        assert.equal(options.nightly_epoch_triggered_rem, true);
        assert.equal(typeof options.dream_runner, 'function');
        return {
          ok: true,
          marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
          within_sleep_window: true,
          sleep_cycle_active: true,
          dreams_generated_this_tick: 0
        };
      }
    });
    assert.equal(epochTick.rem_mode, 'epoch_triggered');
    assert.equal(epochTick.rsi_paused, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function scenarioWallClockDreamsWhilePaused() {
  // Full tick path with isolated state: paused RSI keeps the 47-cycle fixed
  // schedule and reaches the real dream dispatch seam for a due cycle.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pause-tick-'));
  try {
    const stateFile = path.join(tempDir, 'sleep-cycle-state.json');
    const eventsFile = path.join(tempDir, 'sleep-events.jsonl');
    const dreamCalls = [];
    const tick = await runSleepCycleTick({
      env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
      now: new Date('2026-07-05T03:10:30.000Z'),
      sleep_window: SLEEP_WINDOW,
      state_file: stateFile,
      events_file: eventsFile,
      write_report: false,
      nightly_epoch_triggered_rem: false,
      pre_rem_memory_preparation_runner: async () => ({ ok: true }),
      dream_runner: async (options) => {
        dreamCalls.push(options.rem_cycle_number);
        const dreamFile = path.join(
          tempDir,
          'dream-' + String(options.rem_cycle_number) + '.txt'
        );
        fs.writeFileSync(dreamFile, 'real dream content');
        return { ok: true, dream_txt_file: dreamFile };
      }
    });
    assert.equal(tick.ok, true);
    assert.equal(tick.within_sleep_window, true);
    assert.equal(
      tick.rem_cycles_total,
      47,
      'the paused-RSI night must keep all 47 wall-clock REM cycles'
    );
    assert.deepEqual(dreamCalls, [1], 'exactly the one due cycle is claimed');
    assert.equal(tick.dreams_generated_this_tick, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function scenarioEpochModePreservesCompletedCycles() {
  const base = createSleepCycleState({
    now: new Date('2026-07-05T03:00:30.000Z'),
    sleep_window: SLEEP_WINDOW
  });
  assert.equal(base.rem_cycles.length, 47);
  const withProgress = Object.freeze({
    ...base,
    rem_cycles: base.rem_cycles.map((cycle, index) => index < 2
      ? Object.freeze({
          ...cycle,
          status: 'complete',
          stage: 'complete',
          dream_txt_file: '/tmp/dream-' + String(index + 1) + '.txt',
          completed_at: '2026-07-05T03:2' + String(index) + ':00.000Z'
        })
      : cycle)
  });

  const epochMode = reconcileRemSchedule(withProgress, SLEEP_WINDOW, {
    now: new Date('2026-07-05T03:25:00.000Z'),
    nightly_epoch_triggered_rem: true
  });
  assert.equal(epochMode.rem_trigger, 'completed_training_epoch');
  assert.equal(epochMode.rem_interval_minutes, null);
  assert.equal(
    epochMode.rem_cycles.length,
    2,
    'completed REM history must survive the switch to epoch-triggered mode'
  );
  assert.equal(epochMode.rem_cycles.every((c) => c.status === 'complete'), true);

  const stable = reconcileRemSchedule(epochMode, SLEEP_WINDOW, {
    now: new Date('2026-07-05T03:26:00.000Z'),
    nightly_epoch_triggered_rem: true
  });
  assert.equal(stable, epochMode, 'epoch-mode reconcile must be stable');

  const backToWallClock = reconcileRemSchedule(epochMode, SLEEP_WINDOW, {
    now: new Date('2026-07-05T03:30:00.000Z')
  });
  assert.equal(backToWallClock.rem_trigger, 'fixed_schedule');
  assert.equal(backToWallClock.rem_cycles.length, 47);
  assert.equal(
    backToWallClock.rem_cycles.filter((c) => c.status === 'complete').length,
    2,
    'completed cycles must merge back into the wall-clock schedule'
  );
}

function scenarioRestorePolicyReloadsCognitionForFallbacks() {
  const config = { nightly_ollama_reload_policy: 'wake_only' };
  const withinNight = { is_within_sleep_window: () => true };

  for (const reason of [
    'rsi_paused_wall_clock_rem',
    'nightly_training_failed_wall_clock_rem',
    'nightly_training_launch_failure',
    'nightly_training_resume_after_rem_failed'
  ]) {
    const policy = resolveNightlyRestorePolicy(
      config,
      reason,
      NIGHT_NOW,
      withinNight
    );
    assert.equal(
      policy.reload_ollama,
      true,
      reason + ' must restore Ollama cognition for wall-clock dreams'
    );
  }

  const deferred = resolveNightlyRestorePolicy(
    config,
    'nightly_rem_cycle_3',
    NIGHT_NOW,
    withinNight
  );
  assert.equal(
    deferred.reload_ollama,
    false,
    'ordinary mid-night REM handoffs must keep deferring the Ollama reload'
  );
}

async function main() {
  assert.ok(
    Number(process.versions.node.split('.')[0]) >= 24,
    'requires Node 24+'
  );
  await scenarioPausedWithoutSession();
  await scenarioPausedReleasesHeldResources();
  await scenarioPauseSentinelReadFromStatus();
  await scenarioTrainingFailureFallsBackToWallClock();
  await scenarioLaunchFailureLatchSurvivesRestore();
  await scenarioHealthyNightKeepsEpochTriggeredRem();
  await scenarioSchedulerWiresRemModeIntoTick();
  await scenarioWallClockDreamsWhilePaused();
  scenarioEpochModePreservesCompletedCycles();
  scenarioRestorePolicyReloadsCognitionForFallbacks();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_PAUSE_SLEEP_INDEPENDENCE_PASS',
    rsi_pause_never_starves_dreams: true,
    training_failure_falls_back_to_wall_clock_rem: true,
    launch_failure_latch_durable: true,
    completed_rem_history_durable: true
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_RSI_PAUSE_SLEEP_INDEPENDENCE_FAIL',
    error: error && error.stack || String(error)
  }, null, 2));
  process.exit(1);
});
