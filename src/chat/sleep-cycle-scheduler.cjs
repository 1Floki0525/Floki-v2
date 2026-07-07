'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ensureDirSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const { PROJECT_ROOT: ROOT, getPathConfig, getSleepConfig } = require('../config/floki-config.cjs');
const { runSleepCycleTick, loadSleepCycleState } = require('./sleep-cycle.cjs');
const { getProductionNightlyTrainingCoordinator } = require('../self-improvement/training/training-scheduler.cjs');
const {
  loadFreshSelfImprovementConfig,
  loadSelfImprovementConfig
} = require('../self-improvement/config.cjs');
const {
  readDreamEngineControl
} = require('./dream-engine-control.cjs');

const SCHEDULER_CONFIG = getSleepConfig('chat');
const SCHEDULER_TICK_MS = Number(SCHEDULER_CONFIG.scheduler_tick_ms);
const SCHEDULER_HEARTBEAT_STALE_MS = Number(SCHEDULER_CONFIG.scheduler_heartbeat_stale_ms);
const SCHEDULER_HEARTBEAT_REFRESH_MS = Number(SCHEDULER_CONFIG.scheduler_heartbeat_refresh_ms);

function runtimeDirFromConfig() {
  const configured = getPathConfig('chat').chat_runtime_root;
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured);
}

function schedulerPaths(options = {}) {
  const runtimeDir = options.runtime_dir || runtimeDirFromConfig();
  return Object.freeze({
    runtime_dir: runtimeDir,
    pid_file: options.pid_file || path.join(runtimeDir, 'sleep-cycle-scheduler.pid'),
    heartbeat_file: options.heartbeat_file || path.join(runtimeDir, 'sleep-cycle-scheduler.heartbeat.json'),
    status_file: options.status_file || path.join(runtimeDir, 'sleep-cycle-scheduler.status.json'),
    log_file: options.log_file || path.join(runtimeDir, 'sleep-cycle-scheduler.log')
  });
}

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJsonFileSync(filePath);
  } catch (_error) {
    return null;
  }
}

function readPid(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const value = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function writeRuntimeRecord(filePath, record) {
  writeJsonFileAtomicSync(filePath, record);
  return record;
}

function heartbeatAgeMs(heartbeat, now) {
  if (!heartbeat || !heartbeat.observed_at) return null;
  const observed = new Date(heartbeat.observed_at).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(current)) return null;
  return Math.max(0, current - observed);
}

function readSchedulerRuntimeStatus(options = {}) {
  const paths = schedulerPaths(options);
  const now = options.now || new Date();
  const pid = readPid(paths.pid_file);
  const aliveCheck = options.process_is_alive || processIsAlive;
  const processAlive = pid !== null && aliveCheck(pid);
  const heartbeat = safeReadJson(paths.heartbeat_file);
  const statusRecord = safeReadJson(paths.status_file);
  const ageMs = heartbeatAgeMs(heartbeat, now);
  const heartbeatFresh = processAlive && ageMs !== null && ageMs <= SCHEDULER_HEARTBEAT_STALE_MS;
  const active = processAlive && heartbeatFresh;

  return Object.freeze({
    ok: true,
    marker: active
      ? 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_ACTIVE'
      : 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_INACTIVE',
    active,
    pid,
    process_alive: processAlive,
    heartbeat_fresh: heartbeatFresh,
    heartbeat_age_ms: ageMs,
    heartbeat_stale_after_ms: SCHEDULER_HEARTBEAT_STALE_MS,
    heartbeat,
    last_status: statusRecord,
    pid_file: paths.pid_file,
    heartbeat_file: paths.heartbeat_file,
    status_file: paths.status_file,
    log_file: paths.log_file,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function writeHeartbeat(paths, extra = {}) {
  return writeRuntimeRecord(paths.heartbeat_file, {
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_HEARTBEAT',
    pid: process.pid,
    observed_at: new Date().toISOString(),
    ...extra,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function isRecoverableDreamQualityError(error) {
  const message = String(
    error && error.message ? error.message : error
  );

  return (
    message.startsWith('DREAM_QUALITY_CONTRACT_REJECTED_AFTER_') &&
    message.includes(': dream quality violations:')
  );
}


function isRecoverableNightlyRemError(error) {
  const message = String(error && error.message ? error.message : error);
  return message.startsWith('FLOKI_NIGHTLY_REM_') ||
    message.startsWith('FLOKI_HF_REM_') ||
    message.startsWith('FLOKI_V2_HF_REM_');
}

function automaticNightlyCoordinatorEnabled(
  config = loadSelfImprovementConfig()
) {
  return (
    config.training_enabled === true &&
    config.nightly_training_enabled === true &&
    config.nightly_training_provider === 'huggingface' &&
    config.nightly_rem_provider === 'huggingface'
  );
}

function rsiPauseSentinelPresent(config = loadSelfImprovementConfig()) {
  try {
    return fs.existsSync(
      path.join(config.runtime_root, config.pause_file_name)
    );
  } catch (_error) {
    return false;
  }
}

async function runSchedulerIteration(options = {}) {
  const paths = schedulerPaths(options);
  ensureDirSync(paths.runtime_dir);
  const tickRunner = options.tick_runner || runSleepCycleTick;
  const dreamControl = readDreamEngineControl({
    runtime_dir: paths.runtime_dir
  });
  const env = {
    ...process.env,
    ...(options.env || {}),
    FLOKI_ALLOW_SLEEP_CYCLE: '1',
    FLOKI_ALLOW_DREAM_ENGINE:
      dreamControl.enabled === true ? '1' : '0'
  };
  const selfImprovementConfig =
    options.self_improvement_config || loadFreshSelfImprovementConfig();
  const trainingCoordinator =
    Object.prototype.hasOwnProperty.call(options, 'training_coordinator')
      ? options.training_coordinator
      : (automaticNightlyCoordinatorEnabled(selfImprovementConfig)
          ? getProductionNightlyTrainingCoordinator()
          : null);
  const rsiPaused =
    Object.prototype.hasOwnProperty.call(options, 'rsi_paused')
      ? options.rsi_paused === true
      : rsiPauseSentinelPresent(selfImprovementConfig);
  let nightlyTrainingError = null;
  if (trainingCoordinator) {
    try {
      await trainingCoordinator.beforeTick({
        env,
        now: options.now || new Date(),
        rsi_paused: rsiPaused
      });
    } catch (error) {
      nightlyTrainingError = error.stack || error.message;
    }
  }
  // REM ownership for this tick. The RSI pause sentinel and a terminally
  // failed nightly session both hand REM back to the fixed 10-minute
  // wall-clock schedule; only healthy enabled nighttime training keeps
  // the epoch-triggered schedule.
  const remMode =
    trainingCoordinator && typeof trainingCoordinator.remMode === 'function'
      ? trainingCoordinator.remMode({
          now: options.now || new Date(),
          rsi_paused: rsiPaused
        })
      : (trainingCoordinator ? 'epoch_triggered' : 'wall_clock');
  const epochTriggeredRem = remMode === 'epoch_triggered';

  writeHeartbeat(paths, {
    phase: 'tick_start',
    dream_engine_enabled: dreamControl.enabled === true,
    dream_engine_generation: dreamControl.generation,
    dream_engine_control_file:
      dreamControl.control_file || null,
    rsi_paused: rsiPaused,
    rem_mode: remMode,
    nightly_training_error: nightlyTrainingError
  });
  const refresh = setInterval(() => {
    writeHeartbeat(paths, { phase: 'tick_running' });
  }, SCHEDULER_HEARTBEAT_REFRESH_MS);

  let tick;
  try {
    const tickOptions = {
      env,
      runtime_dir: paths.runtime_dir,
      dream_engine_control: dreamControl,
      write_report: options.write_report !== false,
      nightly_epoch_triggered_rem: epochTriggeredRem
    };
    // Explicit clock/state overrides let an isolated harness (daytime night
    // cycle simulation, contract tests) drive the same production tick with
    // simulated timestamps and scoped state files. Production service runs
    // never set these, so default behavior is unchanged.
    if (options.now) tickOptions.now = options.now;
    if (options.state_file) tickOptions.state_file = options.state_file;
    if (options.events_file) tickOptions.events_file = options.events_file;
    if (options.report_file) tickOptions.report_file = options.report_file;
    if (options.dream_options) tickOptions.dream_options = options.dream_options;
    if (typeof options.dream_runner === 'function') {
      tickOptions.dream_runner = options.dream_runner;
    }
    if (trainingCoordinator && epochTriggeredRem) {
      tickOptions.dream_runner = (dreamOptions) =>
        trainingCoordinator.runNightlyRem(dreamOptions);
    }
    tick = await tickRunner(tickOptions);
  } catch (error) {
    if (isRecoverableDreamQualityError(error)) {
      const record = Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_DREAM_REPAIR_QUEUED',
        pid: process.pid,
        degraded: true,
        dream_generated: false,
        rejection_error: error.message,
        tick_completed_at: new Date().toISOString(),
        chat_mode_only: true,
        game_mode_started: false
      });

      writeRuntimeRecord(paths.status_file, record);
      writeHeartbeat(paths, {
        phase: 'idle_after_dream_repair_queued',
        degraded: true,
        dream_generated: false,
        rejection_error: error.message,
        last_tick_completed_at: record.tick_completed_at
      });

      return record;
    }


    if (isRecoverableNightlyRemError(error)) {
      const record = Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_NIGHTLY_REM_RETRY_QUEUED',
        pid: process.pid,
        degraded: true,
        dream_generated: false,
        nightly_rem_error: error.stack || error.message,
        nightly_training_error: nightlyTrainingError,
        tick_completed_at: new Date().toISOString(),
        chat_mode_only: true,
        game_mode_started: false
      });
      writeRuntimeRecord(paths.status_file, record);
      writeHeartbeat(paths, {
        phase: 'idle_after_nightly_rem_retry_queued',
        degraded: true,
        nightly_rem_error: record.nightly_rem_error,
        nightly_training_error: nightlyTrainingError,
        last_tick_completed_at: record.tick_completed_at
      });
      return record;
    }

    const record = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_FATAL_ARCHITECTURE_ERROR',
      pid: process.pid,
      error: error.message,
      fatal_architecture_error: true,
      stopped_at: new Date().toISOString(),
      chat_mode_only: true,
      game_mode_started: false
    });
    writeRuntimeRecord(paths.status_file, record);
    writeHeartbeat(paths, {
      ok: false,
      phase: 'fatal_architecture_error',
      fatal_architecture_error: true,
      error: error.message
    });
    throw error;
  } finally {
    clearInterval(refresh);
  }

  if (!tick || tick.ok !== true) {
    throw new Error('sleep cycle tick did not return an ok result');
  }

  if (trainingCoordinator) {
    try {
      await trainingCoordinator.afterTick({
        env,
        tick,
        now: options.now || new Date(),
        rsi_paused: rsiPaused
      });
    } catch (error) {
      nightlyTrainingError = error.stack || error.message;
    }
  }

  const state = loadSleepCycleState(
    options.state_file ? { state_file: options.state_file } : {}
  );
  const record = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TICK_PASS',
    pid: process.pid,
    tick_completed_at: new Date().toISOString(),
    tick_marker: tick.marker,
    within_sleep_window: tick.within_sleep_window === true,
    sleep_cycle_active: tick.sleep_cycle_active === true,
    dreams_generated_this_tick: Number(tick.dreams_generated_this_tick || 0),
    dream_engine_enabled: dreamControl.enabled === true,
    dream_engine_generation: dreamControl.generation,
    dream_generation_suspended:
      tick.dream_generation_suspended === true,
    dream_engine_control_file:
      dreamControl.control_file || null,
    current_sleep_date: state ? state.current_sleep_date : null,
    nightly_training_enabled: Boolean(trainingCoordinator),
    rsi_paused: rsiPaused,
    rem_mode: remMode,
    nightly_training_error: nightlyTrainingError,
    chat_mode_only: true,
    game_mode_started: false
  });

  writeRuntimeRecord(paths.status_file, record);
  writeHeartbeat(paths, {
    phase: 'idle',
    last_tick_completed_at: record.tick_completed_at,
    last_tick_marker: record.tick_marker,
    dream_engine_enabled: dreamControl.enabled === true,
    dream_engine_generation: dreamControl.generation,
    dream_engine_control_file:
      dreamControl.control_file || null,
    rsi_paused: rsiPaused,
    rem_mode: remMode,
    nightly_training_error: nightlyTrainingError
  });
  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNextTick(ms, shouldStop) {
  const started = Date.now();
  while (!shouldStop() && Date.now() - started < ms) {
    const remaining = ms - (Date.now() - started);
    await delay(Math.min(500, Math.max(1, remaining)));
  }
}

const SCHEDULER_STOP_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  const delayMs = Math.max(1, Math.floor(Number(milliseconds) || 1));
  Atomics.wait(SCHEDULER_STOP_SLEEP_BUFFER, 0, 0, delayMs);
}

function waitForProcessExitSync(pid, timeoutMs, pollMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const intervalMs = Math.max(1, Number(pollMs) || 50);

  while (processIsAlive(pid) && Date.now() < deadline) {
    sleepSync(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }

  return !processIsAlive(pid);
}

function cleanupSchedulerProcess(pid, paths, timeoutMs) {
  if (!pid || !processIsAlive(pid)) {
    if (pid && fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);
    return { ok: true, marker: 'SCHEDULER_CLEANUP_NO_PROCESS', pid };
  }

  const gracefulTimeoutMs = Math.max(1, Number(timeoutMs) || 5000);
  const forceTimeoutMs = Math.min(2000, gracefulTimeoutMs);

  process.kill(pid, 'SIGTERM');

  let exited = waitForProcessExitSync(pid, gracefulTimeoutMs, 100);
  let forced = false;

  if (!exited) {
    forced = true;
    process.kill(pid, 'SIGKILL');
    exited = waitForProcessExitSync(pid, forceTimeoutMs, 50);
  }

  if (!exited) {
    return {
      ok: false,
      marker: 'SCHEDULER_CLEANUP_PROCESS_STILL_ALIVE',
      pid,
      forced,
      pid_file_preserved: fs.existsSync(paths.pid_file)
    };
  }

  if (fs.existsSync(paths.pid_file)) fs.unlinkSync(paths.pid_file);

  return {
    ok: true,
    marker: forced
      ? 'SCHEDULER_CLEANUP_FORCED'
      : 'SCHEDULER_CLEANUP_DONE',
    pid,
    forced
  };
}

async function runSchedulerService(options = {}) {
  const paths = schedulerPaths(options);
  ensureDirSync(paths.runtime_dir);
  const injectedCoordinator =
    Object.prototype.hasOwnProperty.call(options, 'training_coordinator');

  const existingPid = readPid(paths.pid_file);
  if (existingPid && existingPid !== process.pid && processIsAlive(existingPid)) {
    throw new Error('sleep-cycle scheduler already active with pid ' + existingPid);
  }

  fs.writeFileSync(paths.pid_file, String(process.pid) + '\n');

  let stopping = false;
  const requestStop = () => {
    stopping = true;
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);

  writeRuntimeRecord(paths.status_file, {
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STARTED',
    pid: process.pid,
    started_at: new Date().toISOString(),
    tick_interval_ms: SCHEDULER_TICK_MS,
    chat_mode_only: true,
    game_mode_started: false
  });
  writeHeartbeat(paths, { phase: 'starting' });

  try {
    while (!stopping) {
      // The coordinator (and the RSI pause sentinel) are re-evaluated on
      // every iteration so live pause/enable controls take effect without
      // a scheduler restart. An explicitly injected coordinator is kept.
      const iterationOptions = { ...options, ...paths };
      if (!injectedCoordinator) delete iterationOptions.training_coordinator;
      await runSchedulerIteration(iterationOptions);
      await waitForNextTick(SCHEDULER_TICK_MS, () => stopping);
    }
  } catch (error) {
    writeRuntimeRecord(paths.status_file, {
      ok: false,
      marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_ERROR',
      pid: process.pid,
      error: error.message,
      stopped_at: new Date().toISOString(),
      chat_mode_only: true,
      game_mode_started: false
    });
    throw error;
  } finally {
    const shutdownCoordinator = injectedCoordinator
      ? options.training_coordinator
      : (automaticNightlyCoordinatorEnabled(loadFreshSelfImprovementConfig())
          ? getProductionNightlyTrainingCoordinator()
          : null);
    if (shutdownCoordinator) {
      try {
        await shutdownCoordinator.shutdown({
          reason: 'sleep_scheduler_service_stop'
        });
      } catch (error) {
        writeRuntimeRecord(paths.status_file, {
          ok: false,
          marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TRAINING_SHUTDOWN_ERROR',
          pid: process.pid,
          error: error.stack || error.message,
          stopped_at: new Date().toISOString(),
          chat_mode_only: true,
          game_mode_started: false
        });
      }
    }
    const currentPid = readPid(paths.pid_file);
    if (currentPid === process.pid) fs.rmSync(paths.pid_file, { force: true });
  }

  const stopped = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOPPED',
    pid: process.pid,
    stopped_at: new Date().toISOString(),
    chat_mode_only: true,
    game_mode_started: false
  });
  writeRuntimeRecord(paths.status_file, stopped);
  return stopped;
}

async function main() {
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(readSchedulerRuntimeStatus(), null, 2));
    return;
  }

  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(await runSchedulerIteration(), null, 2));
    return;
  }

  if (process.argv.includes('--service')) {
    await runSchedulerService();
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_READY',
    commands: ['--service', '--once', '--status'],
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

function stopScheduler(options = {}) {
  const paths = schedulerPaths(options);
  const pidFile = paths.pid_file;
  
  if (!fs.existsSync(pidFile)) {
    return { ok: true, marker: 'SCHEDULER_STOPPED_NO_PID' };
  }
  
  try {
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.unlinkSync(pidFile);
      return { ok: true, marker: 'SCHEDULER_STOPPED_NO_VALID_PID' };
    }
    
    return cleanupSchedulerProcess(pid, paths, 5000);
  } catch (e) {
    return { ok: false, marker: 'SCHEDULER_STOP_ERROR', error: e.message };
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_ERROR',
      error: error.message,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
     process.exit(1);
   });
}

module.exports = {
  automaticNightlyCoordinatorEnabled,
  rsiPauseSentinelPresent,
  ROOT,
  SCHEDULER_TICK_MS,
  SCHEDULER_HEARTBEAT_STALE_MS,
  SCHEDULER_HEARTBEAT_REFRESH_MS,
  schedulerPaths,
  processIsAlive,
  readSchedulerRuntimeStatus,
  writeHeartbeat,
  isRecoverableDreamQualityError,
  runSchedulerIteration,
  runSchedulerService,
  waitForNextTick,
  stopScheduler
};
