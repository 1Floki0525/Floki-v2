'use strict';

// Daytime night-cycle simulation harness.
//
// Rehearses the full nighttime sleep architecture (RSI-paused wall-clock REM,
// enabled epoch -> REM -> resume training, simulated 07:00 one-candidate
// finalization) during the day WITHOUT changing the system clock and WITHOUT
// touching the production 23:00-07:00 schedule or production night state.
//
// Safety contract:
// - Disabled by default: nothing here runs unless this CLI/module is invoked
//   explicitly with a mode flag.
// - Every stateful path (sleep state, events, scheduler runtime, nightly
//   session, REM claims, GPU lock, adapters, datasets, candidates, dreams) is
//   scoped under state/floki/night-cycle-sim/<run>; construction asserts the
//   scoped paths differ from production before anything is written.
// - Only REAL production functions run: runSchedulerIteration, the sleep
//   tick, the nightly training coordinator, the dream engine, the QLoRA
//   training container and HF REM inference. No fake dreams, no fake epochs,
//   no fabricated candidates - failures surface as failures.
// - The virtual clock is injected via the existing options.now /
//   FLOKI_SLEEP_TEST_NOW / now_provider seams. The host clock is never moved.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROJECT_ROOT } = require('../config/floki-config.cjs');
const { runSchedulerIteration } = require('./sleep-cycle-scheduler.cjs');
const {
  getSleepWindowForDate,
  loadSleepCycleState
} = require('./sleep-cycle.cjs');
const { runDreamEngineOnce } = require('./dream-engine.cjs');
const {
  createNightlyTrainingCoordinator,
  readRemClaims
} = require('../self-improvement/training/training-scheduler.cjs');
const {
  readNightlySession
} = require('../self-improvement/training/nightly-training-session.cjs');
const {
  preflightTrainingEngine
} = require('../self-improvement/training/master-preflight.cjs');
const {
  enterTrainingResource,
  exitTrainingResource
} = require('../self-improvement/training/runtime-client.cjs');
const {
  loadFreshSelfImprovementConfig
} = require('../self-improvement/config.cjs');
const { splitPipeList } = require('../self-improvement/training/qlora-config.cjs');

const SIM_BASE = path.join(PROJECT_ROOT, 'state', 'floki', 'night-cycle-sim');
const SIM_LATEST_FILE = path.join(SIM_BASE, 'latest.json');

// Config keys that must never point at production locations while simulating.
const SCOPED_PATH_KEYS = Object.freeze([
  'runtime_root',
  'training_runtime_root',
  'training_rem_claim_file',
  'nightly_hf_operation_lock_file',
  'gpu_ownership_lock_file',
  'adapter_root',
  'dataset_root',
  'candidate_root'
]);

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function createSimClock(startAt) {
  const virtualStartMs = new Date(startAt).getTime();
  if (!Number.isFinite(virtualStartMs)) {
    throw new Error('night-cycle simulation requires a valid virtual start time');
  }
  const realStartMs = Date.now();
  let jumpMs = 0;
  const now = () => new Date(virtualStartMs + (Date.now() - realStartMs) + jumpMs);
  return Object.freeze({
    now,
    nowIso: () => now().toISOString(),
    jumpTo(target) {
      const targetMs = new Date(target).getTime();
      if (!Number.isFinite(targetMs)) throw new Error('invalid jump target');
      const currentMs = now().getTime();
      if (targetMs < currentMs) {
        throw new Error('night-cycle simulation clock only moves forward');
      }
      jumpMs += targetMs - currentMs;
      return now();
    }
  });
}

function assertScopedIsolation(scoped, production, simRoot) {
  const resolvedSimRoot = path.resolve(simRoot);
  if (!resolvedSimRoot.startsWith(path.resolve(SIM_BASE) + path.sep) &&
      resolvedSimRoot !== path.resolve(SIM_BASE)) {
    // Custom roots (contract tests) are allowed anywhere EXCEPT production
    // state roots; the per-key checks below still apply.
  }
  for (const key of SCOPED_PATH_KEYS) {
    const scopedValue = path.resolve(String(scoped[key]));
    const productionValue = path.resolve(String(production[key]));
    if (scopedValue === productionValue) {
      throw new Error(
        'night-cycle simulation refused to run: ' + key +
        ' still points at the production path ' + productionValue
      );
    }
    if (!scopedValue.startsWith(resolvedSimRoot + path.sep)) {
      throw new Error(
        'night-cycle simulation refused to run: ' + key +
        ' is outside the simulation root: ' + scopedValue
      );
    }
  }
}

function cdiGpuProbe(config, options = {}) {
  const execute = options.spawnSync || spawnSync;
  const gpuArgs = splitPipeList(config.training_gpu_device_args);
  const probe = execute(
    config.sandbox_engine,
    ['run', '--rm', ...gpuArgs, '--entrypoint', 'nvidia-smi', config.training_container_image, '-L'],
    {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: Number(config.podman_command_timeout_ms),
      maxBuffer: Number(config.podman_output_buffer_bytes)
    }
  );
  const stdout = String(probe.stdout || '');
  const stderr = String(probe.stderr || '');
  const gpuLine = stdout.split(/\r?\n/).find((line) => /^GPU \d+:/.test(line)) || null;
  return Object.freeze({
    marker: 'FLOKI_V2_NIGHT_SIM_CDI_GPU_PROBE',
    engine: config.sandbox_engine,
    ok: !probe.error && probe.status === 0 && Boolean(gpuLine),
    status: probe.error ? null : probe.status,
    gpu: gpuLine,
    error: probe.error
      ? probe.error.message
      : (probe.status !== 0 ? (stderr || stdout).trim().slice(0, 2000) : null)
  });
}

function createNightCycleSimulation(options = {}) {
  const production = options.production_config || loadFreshSelfImprovementConfig();
  const runId = options.run_id ||
    ('sim-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14));
  const root = options.root || path.join(SIM_BASE, runId);

  const scopedRoots = {
    runtime_root: path.join(root, 'runtime'),
    training_runtime_root: path.join(root, 'training-runtime'),
    training_rem_claim_file: path.join(root, 'training-runtime', 'rem-claims.json'),
    nightly_hf_operation_lock_file: path.join(root, 'training-runtime', 'hf-operation.lock'),
    gpu_ownership_lock_file: path.join(root, 'gpu-owner.lock'),
    adapter_root: path.join(root, 'adapters'),
    dataset_root: path.join(root, 'datasets'),
    candidate_root: path.join(root, 'candidates')
  };
  const config = Object.freeze({
    ...production,
    ...scopedRoots,
    ...(options.config_overrides || {})
  });
  assertScopedIsolation(config, production, root);

  const sleepPaths = Object.freeze({
    runtime_dir: path.join(root, 'chat-runtime'),
    state_file: path.join(root, 'sleep', 'sleep-cycle-state.json'),
    events_file: path.join(root, 'sleep', 'sleep-events.jsonl'),
    report_file: path.join(root, 'sleep', 'latest-sleep-cycle.json'),
    dream_root: path.join(root, 'dreams'),
    dream_index_file: path.join(root, 'dreams', 'dream-index.json')
  });

  const anchor = options.window_anchor ? new Date(options.window_anchor) : new Date();
  const sleepWindow = getSleepWindowForDate(anchor);
  const clock = createSimClock(
    options.virtual_start ||
    new Date(new Date(sleepWindow.start_at).getTime() + 30000)
  );

  const resourceMode = options.live_resources === true ? 'live' : 'recorded';
  const resourceTransactions = [];
  const enterResource = resourceMode === 'live'
    ? (runIdValue) => enterTrainingResource(runIdValue, production)
    : async (runIdValue) => {
        resourceTransactions.push(Object.freeze({
          action: 'enter', run_id: runIdValue, mode: 'recorded_not_live',
          at: clock.nowIso()
        }));
        return Object.freeze({ ok: true, recorded: true });
      };
  const exitResource = resourceMode === 'live'
    ? (reason) => exitTrainingResource(reason, production)
    : async (reason) => {
        resourceTransactions.push(Object.freeze({
          action: 'exit', reason, mode: 'recorded_not_live',
          at: clock.nowIso()
        }));
        return Object.freeze({ ok: true, recorded: true });
      };

  // Real dream engine, isolated dream store. Nightly (epoch-triggered) REM
  // supplies its own HF dream_generator through the coordinator; wall-clock
  // dreams use the production cognition model as they do at night.
  const dreamRunner = options.dream_runner || ((dreamOptions) => runDreamEngineOnce({
    ...dreamOptions,
    dream_root: sleepPaths.dream_root,
    index_file: sleepPaths.dream_index_file
  }));

  const coordinator = options.training_coordinator || createNightlyTrainingCoordinator({
    config,
    now_provider: clock.now,
    enter_resource: enterResource,
    exit_resource: exitResource,
    read_sleep_state: () => loadSleepCycleState({ state_file: sleepPaths.state_file }),
    run_dream_engine: dreamRunner,
    // The scoped session/config are frozen for the whole simulation run.
    load_config: () => config,
    ...(options.coordinator_overrides || {})
  });

  const events = [];
  function record(type, detail) {
    events.push(Object.freeze({
      type,
      at_virtual: clock.nowIso(),
      at_real: new Date().toISOString(),
      ...detail
    }));
  }

  async function tick(tickOptions = {}) {
    const rsiPaused = tickOptions.rsi_paused === true;
    const nowVirtual = clock.now();
    const result = await runSchedulerIteration({
      now: nowVirtual,
      env: {
        FLOKI_SLEEP_TEST_NOW: nowVirtual.toISOString(),
        FLOKI_ALLOW_DREAM_ENGINE: '1'
      },
      runtime_dir: sleepPaths.runtime_dir,
      state_file: sleepPaths.state_file,
      events_file: sleepPaths.events_file,
      report_file: sleepPaths.report_file,
      write_report: false,
      training_coordinator: tickOptions.without_coordinator === true ? null : coordinator,
      rsi_paused: rsiPaused,
      self_improvement_config: config,
      dream_runner: dreamRunner,
      dream_options: { sleep_kind: 'nightly_sleep', simulation: true }
    });
    record('tick', {
      rsi_paused: rsiPaused,
      rem_mode: result.rem_mode,
      tick_marker: result.tick_marker,
      dreams_generated: result.dreams_generated_this_tick,
      nightly_training_error: result.nightly_training_error || null
    });
    return result;
  }

  function status() {
    const session = readNightlySession(config);
    const sleepState = loadSleepCycleState({ state_file: sleepPaths.state_file });
    const claims = readRemClaims(config);
    const claimRows = claims && claims.claims ? Object.values(claims.claims) : [];
    const candidateIds = fs.existsSync(config.candidate_root)
      ? fs.readdirSync(config.candidate_root).filter((name) => !name.startsWith('.'))
      : [];
    const cycles = sleepState && Array.isArray(sleepState.rem_cycles)
      ? sleepState.rem_cycles
      : [];
    return Object.freeze({
      marker: 'FLOKI_V2_NIGHT_CYCLE_SIMULATION_STATUS',
      simulation: true,
      run_id: runId,
      root,
      resource_mode: resourceMode,
      virtual_now: clock.nowIso(),
      sleep_window: sleepWindow,
      rem_cycles_total: cycles.length,
      rem_cycles_completed: cycles.filter((c) => c && c.status === 'complete').length,
      rem_cycles_pending: cycles.filter((c) => c && c.status === 'pending').length,
      rem_cycles_missed: cycles.filter((c) => c && c.status === 'missed').length,
      rem_trigger: sleepState ? sleepState.rem_trigger : null,
      session: session ? Object.freeze({
        run_id: session.run_id,
        status: session.status,
        sleep_date: session.sleep_date,
        segment_number: Number(session.segment_number || 0),
        completed_epochs: Number(session.completed_epochs || 0),
        rem_cycles_completed: Number(session.rem_cycles_completed || 0),
        training_failed: session.training_failed === true,
        training_error: session.training_error || null,
        finalized: session.finalized === true,
        finalization_reason: session.finalization_reason || null,
        candidate_id: session.candidate_id || null,
        latest_checkpoint: session.latest_checkpoint || null,
        current_container: session.current_container || null
      }) : null,
      rem_claims_complete: claimRows.filter((c) => c && c.status === 'complete').length,
      rem_claims_failed: claimRows.filter((c) => c && c.status === 'failed').length,
      candidate_ids: Object.freeze(candidateIds),
      resource_transactions: Object.freeze(resourceTransactions.slice()),
      events: Object.freeze(events.slice(-200))
    });
  }

  function persistStatus(extra = {}) {
    const snapshot = { ...status(), ...extra, persisted_at: new Date().toISOString() };
    atomicWriteJson(path.join(root, 'simulation-status.json'), snapshot);
    if (options.publish_latest !== false) {
      atomicWriteJson(SIM_LATEST_FILE, snapshot);
    }
    return snapshot;
  }

  return Object.freeze({
    run_id: runId,
    root,
    config,
    production_config: production,
    sleep_window: sleepWindow,
    sleep_paths: sleepPaths,
    clock,
    coordinator,
    resource_mode: resourceMode,
    tick,
    status,
    persistStatus,
    record
  });
}

function readLatestSimulationStatus() {
  if (!fs.existsSync(SIM_LATEST_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SIM_LATEST_FILE, 'utf8'));
  } catch (_error) {
    return null;
  }
}

// Paused-RSI daytime proof: wall-clock REM cadence with zero training and
// zero candidates. Generates `dreams` REAL dreams (default 1) at their
// 10-minute offsets, then jumps deeper into the night to show that skipped
// wall-clock slots are truthfully marked missed instead of flooding.
async function runPausedSimulation(options = {}) {
  const sim = options.simulation || createNightCycleSimulation(options);
  const dreamsRequested = Math.max(0, Number(options.dreams == null ? 1 : options.dreams));
  const windowStartMs = new Date(sim.sleep_window.start_at).getTime();
  const intervalMs = Number(sim.config.rem_interval_minutes || 10) * 60000;

  const first = await sim.tick({ rsi_paused: true });
  const ticks = [first];
  for (let index = 1; index <= dreamsRequested; index += 1) {
    sim.clock.jumpTo(new Date(windowStartMs + index * intervalMs + 30000));
    ticks.push(await sim.tick({ rsi_paused: true }));
  }
  // Jump three intervals ahead: intermediate never-attempted slots must be
  // recorded as missed (bounded truthful catch-up), and exactly one dream may
  // dispatch for the newly due slot.
  const skipTarget = new Date(
    windowStartMs + (dreamsRequested + 3) * intervalMs + 30000
  );
  if (options.skip_gap !== false) {
    sim.clock.jumpTo(skipTarget);
    ticks.push(await sim.tick({ rsi_paused: true }));
  }

  const summary = sim.status();
  const proof = Object.freeze({
    marker: 'FLOKI_V2_NIGHT_SIM_PAUSED_PASS',
    ok:
      ticks.every((t) => t.ok === true && t.rem_mode === 'wall_clock' && t.rsi_paused === true) &&
      summary.session === null &&
      summary.candidate_ids.length === 0,
    rem_mode_always_wall_clock: ticks.every((t) => t.rem_mode === 'wall_clock'),
    dreams_generated: ticks.reduce((total, t) => total + Number(t.dreams_generated_this_tick || 0), 0),
    training_session_created: summary.session !== null,
    candidates: summary.candidate_ids.length,
    summary
  });
  sim.persistStatus({ mode: 'paused', proof });
  return Object.freeze({ sim, ticks, proof });
}

// Enabled-RSI nighttime proof: one full REAL bounded training epoch, exactly
// one REAL REM dream after it, training resumes for epoch 2, then the
// simulated 07:00 boundary compiles at most one pending candidate backed by
// the real epoch evidence. Long-running: launches real GPU containers.
async function runEnabledRehearsal(options = {}) {
  const sim = options.simulation || createNightCycleSimulation({
    live_resources: true,
    ...options
  });
  const pollRealMs = Math.max(2000, Number(options.poll_real_ms || 15000));
  const timeoutRealMs = Math.max(60000, Number(options.timeout_real_ms || 45 * 60000));
  const deadline = Date.now() + timeoutRealMs;

  const enginePreflight = preflightTrainingEngine(sim.config);
  const gpuProbe = options.skip_gpu_probe === true
    ? null
    : cdiGpuProbe(sim.config);
  sim.record('preflight', { engine: enginePreflight, gpu_probe: gpuProbe });
  if (gpuProbe && gpuProbe.ok !== true) {
    const failure = Object.freeze({
      marker: 'FLOKI_V2_NIGHT_SIM_ENABLED_BLOCKED',
      ok: false,
      reason: 'cdi_gpu_probe_failed',
      engine_preflight: enginePreflight,
      gpu_probe: gpuProbe
    });
    sim.persistStatus({ mode: 'enabled', proof: failure });
    return Object.freeze({ sim, proof: failure });
  }

  const phases = {
    epoch1_started: null,
    epoch1_completed: null,
    rem1_completed: null,
    epoch2_started: null,
    finalized: null
  };
  // Resuming an interrupted rehearsal: adopt the REAL recorded timestamps of
  // phases that already happened in this simulation root instead of
  // re-running a whole training epoch.
  const resumedSession = sim.status().session;
  if (resumedSession && resumedSession.completed_epochs >= 1) {
    const raw = readNightlySession(sim.config);
    phases.epoch1_started = raw.segment_started_at || raw.created_at;
    phases.epoch1_completed = raw.last_epoch_completed_at || raw.updated_at;
    sim.record('phase', { phase: 'resumed_with_completed_epoch', session: resumedSession });
  }
  let lastTick = null;

  while (Date.now() < deadline) {
    lastTick = await sim.tick({ rsi_paused: false });
    const view = sim.status();
    const session = view.session;
    if (session && session.current_container && session.segment_number === 1 && !phases.epoch1_started) {
      phases.epoch1_started = sim.clock.nowIso();
      sim.record('phase', { phase: 'epoch1_started', session });
    }
    if (session && session.completed_epochs >= 1 && !phases.epoch1_completed) {
      phases.epoch1_completed = sim.clock.nowIso();
      sim.record('phase', { phase: 'epoch1_completed', session });
    }
    if (session && session.rem_cycles_completed >= 1 && !phases.rem1_completed) {
      phases.rem1_completed = sim.clock.nowIso();
      sim.record('phase', { phase: 'rem1_completed', session });
    }
    if (session && session.rem_cycles_completed >= 1 && session.segment_number >= 2 &&
        session.current_container && !phases.epoch2_started) {
      phases.epoch2_started = sim.clock.nowIso();
      sim.record('phase', { phase: 'epoch2_started', session });
      break;
    }
    if (session && session.training_failed === true && !session.current_container) {
      sim.record('phase', { phase: 'training_failed_surfaced', session });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollRealMs));
  }

  // Simulated morning boundary: no new epoch, checkpoint/stop, at most one
  // candidate compiled from REAL epoch evidence.
  sim.clock.jumpTo(new Date(new Date(sim.sleep_window.end_at).getTime() + 60000));
  lastTick = await sim.tick({ rsi_paused: false });
  let view = sim.status();
  if (view.session && view.session.finalized) {
    phases.finalized = sim.clock.nowIso();
  }
  // Reset-reconciliation proof: a second morning tick must not duplicate the
  // candidate or reopen the night.
  const reconciliationTick = await sim.tick({ rsi_paused: false });
  view = sim.status();

  const proof = Object.freeze({
    marker: 'FLOKI_V2_NIGHT_SIM_ENABLED_RESULT',
    ok:
      Boolean(phases.epoch1_started && phases.epoch1_completed &&
        phases.rem1_completed && phases.epoch2_started && phases.finalized) &&
      view.candidate_ids.length <= 1 &&
      view.session !== null && view.session.finalized === true,
    phases,
    engine_preflight: enginePreflight,
    gpu_probe: gpuProbe,
    candidates: view.candidate_ids,
    candidate_count: view.candidate_ids.length,
    rem_claims_complete: view.rem_claims_complete,
    finalization_reason: view.session ? view.session.finalization_reason : null,
    training_error: view.session ? view.session.training_error : null,
    last_tick_marker: lastTick ? lastTick.tick_marker : null,
    reconciliation_tick_ok: reconciliationTick.ok === true,
    summary: view
  });
  sim.persistStatus({ mode: 'enabled', proof });
  return Object.freeze({ sim, proof });
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
  };

  if (has('--status')) {
    console.log(JSON.stringify(readLatestSimulationStatus(), null, 2));
    return;
  }
  if (has('--paused')) {
    const { proof } = await runPausedSimulation({
      dreams: Number(valueOf('--dreams', '1'))
    });
    console.log(JSON.stringify(proof, null, 2));
    if (proof.ok !== true) process.exitCode = 1;
    return;
  }
  if (has('--enabled')) {
    const overrides = {};
    const maxRecords = Number(valueOf('--dataset-max-records', '24'));
    if (Number.isFinite(maxRecords) && maxRecords > 0) {
      overrides.dataset_max_records = maxRecords;
    }
    const resumeRunId = valueOf('--resume', null);
    const { proof } = await runEnabledRehearsal({
      live_resources: !has('--recorded-resources'),
      timeout_real_ms: Number(valueOf('--timeout-minutes', '45')) * 60000,
      config_overrides: overrides,
      ...(resumeRunId ? { run_id: resumeRunId } : {})
    });
    console.log(JSON.stringify(proof, null, 2));
    if (proof.ok !== true) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NIGHT_CYCLE_SIMULATION_READY',
    disabled_by_default: true,
    commands: [
      '--paused [--dreams N]',
      '--enabled [--recorded-resources] [--dataset-max-records N] [--timeout-minutes N]',
      '--status'
    ]
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_NIGHT_CYCLE_SIMULATION_ERROR',
      error: error.stack || error.message
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  SIM_BASE,
  SIM_LATEST_FILE,
  SCOPED_PATH_KEYS,
  cdiGpuProbe,
  createNightCycleSimulation,
  createSimClock,
  readLatestSimulationStatus,
  runEnabledRehearsal,
  runPausedSimulation
};
