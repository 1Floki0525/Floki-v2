'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ensureDirSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const { PROJECT_ROOT: ROOT, getPathConfig } = require('../config/floki-config.cjs');
const { runSleepCycleTick, loadSleepCycleState } = require('./sleep-cycle.cjs');

const SCHEDULER_TICK_MS = 30000;
const SCHEDULER_HEARTBEAT_STALE_MS = 90000;
const SCHEDULER_HEARTBEAT_REFRESH_MS = 30000;

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

async function runSchedulerIteration(options = {}) {
  const paths = schedulerPaths(options);
  ensureDirSync(paths.runtime_dir);
  const tickRunner = options.tick_runner || runSleepCycleTick;
  const env = {
    ...process.env,
    ...(options.env || {}),
    FLOKI_ALLOW_SLEEP_CYCLE: '1',
    FLOKI_ALLOW_DREAM_ENGINE: '1'
  };

  writeHeartbeat(paths, { phase: 'tick_start' });
  const refresh = setInterval(() => {
    writeHeartbeat(paths, { phase: 'tick_running' });
  }, SCHEDULER_HEARTBEAT_REFRESH_MS);

  let tick;
  try {
    tick = await tickRunner({
      env,
      write_report: options.write_report !== false
    });
  } finally {
    clearInterval(refresh);
  }

  if (!tick || tick.ok !== true) {
    throw new Error('sleep cycle tick did not return an ok result');
  }

  const state = loadSleepCycleState();
  const record = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_TICK_PASS',
    pid: process.pid,
    tick_completed_at: new Date().toISOString(),
    tick_marker: tick.marker,
    within_sleep_window: tick.within_sleep_window === true,
    sleep_cycle_active: tick.sleep_cycle_active === true,
    dreams_generated_this_tick: Number(tick.dreams_generated_this_tick || 0),
    current_sleep_date: state ? state.current_sleep_date : null,
    chat_mode_only: true,
    game_mode_started: false
  });

  writeRuntimeRecord(paths.status_file, record);
  writeHeartbeat(paths, {
    phase: 'idle',
    last_tick_completed_at: record.tick_completed_at,
    last_tick_marker: record.tick_marker
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

async function runSchedulerService(options = {}) {
  const paths = schedulerPaths(options);
  ensureDirSync(paths.runtime_dir);

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
      await runSchedulerIteration({ ...options, ...paths });
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
  ROOT,
  SCHEDULER_TICK_MS,
  SCHEDULER_HEARTBEAT_STALE_MS,
  SCHEDULER_HEARTBEAT_REFRESH_MS,
  schedulerPaths,
  processIsAlive,
  readSchedulerRuntimeStatus,
  writeHeartbeat,
  runSchedulerIteration,
  runSchedulerService,
  waitForNextTick
};
