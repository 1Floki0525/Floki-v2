'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ensureParentDirSync,
  existsSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const { readJsonlSync } = require('../util/jsonl.cjs');
const { reconcileDreamArchive } = require('./dream-archive.cjs');
const {
  dreamRootFallback,
  getDreamRoot
} = require('./dream-engine.cjs');
const {
  SLEEP_CYCLE_OUTPUT_DIR,
  yamlTimezone,
  DEFAULT_IDLE_RESUME_SECONDS,
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  loadSleepCycleState
} = require('./sleep-cycle.cjs');
const {
  getDreamMemoryIndexFile
} = require('./dream-memory-consolidation.cjs');

const { PROJECT_ROOT: ROOT } = require('../config/floki-config.cjs');
const DREAM_STATUS_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'dream-status');

function nowDate(options = {}) {
  const env = options.env || process.env;

  if (options.now) {
    return new Date(options.now);
  }

  if (env.FLOKI_SLEEP_TEST_NOW) {
    return new Date(env.FLOKI_SLEEP_TEST_NOW);
  }

  return new Date();
}

function localTimeString(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function safeReadJson(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    return readJsonFileSync(filePath, fallback);
  } catch (_error) {
    return fallback;
  }
}

function readJsonlSafe(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    return readJsonlSync(filePath);
  } catch (_error) {
    return [];
  }
}

function cycleCounts(cycles) {
  const list = Array.isArray(cycles) ? cycles : [];

  return Object.freeze({
    total: list.length,
    complete: list.filter((cycle) => cycle.status === 'complete').length,
    pending: list.filter((cycle) => cycle.status === 'pending').length,
    dreaming: list.filter((cycle) => cycle.status === 'dreaming').length
  });
}

function latestByCreatedAt(records) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === 'object');

  if (list.length === 0) {
    return null;
  }

  return list.slice().sort((a, b) => {
    const aTime = new Date(a.created_at || a.dream_created_at || 0).getTime();
    const bTime = new Date(b.created_at || b.dream_created_at || 0).getTime();
    return aTime - bTime;
  })[list.length - 1];
}

function latestDreamInfo(options = {}) {
  const dreamRoot = getDreamRoot(options);
  const dreamIndexFile = options.dream_index_file || path.join(dreamRoot, 'dream-index.jsonl');
  const reconciliation = reconcileDreamArchive({ ...options, dream_root: dreamRoot, index_file: dreamIndexFile });
  const memoryIndexFile = options.dream_memory_index_file || getDreamMemoryIndexFile(options);
  const dreamRecords = readJsonlSafe(dreamIndexFile);
  const memoryRecords = readJsonlSafe(memoryIndexFile);
  const latestDream = latestByCreatedAt(dreamRecords);
  const latestMemory = latestByCreatedAt(memoryRecords);

  let latestMetadata = null;
  let latestTitle = null;

  if (latestDream && latestDream.dream_metadata_file && existsSync(latestDream.dream_metadata_file)) {
    latestMetadata = safeReadJson(latestDream.dream_metadata_file, null);
  }

  latestTitle = latestDream && (latestDream.title || latestDream.dream_title)
    ? String(latestDream.title || latestDream.dream_title)
    : latestMetadata && latestMetadata.title
      ? String(latestMetadata.title)
      : latestMemory && latestMemory.dream_title
        ? String(latestMemory.dream_title)
        : null;

  return Object.freeze({
    dream_index_file: dreamIndexFile,
    dream_memory_index_file: memoryIndexFile,
    dream_count_indexed: dreamRecords.length,
    dream_archive_reconciliation: reconciliation,
    dream_memory_count_indexed: memoryRecords.length,
    latest_dream_file: latestDream && latestDream.dream_txt_file ? latestDream.dream_txt_file : null,
    latest_dream_metadata_file: latestDream && latestDream.dream_metadata_file ? latestDream.dream_metadata_file : null,
    latest_dream_title: latestTitle,
    latest_dream_memory_written: Boolean(latestMemory && latestMemory.dream_txt_file),
    latest_dream_memory_id: latestMemory && latestMemory.persistent_memory_id ? latestMemory.persistent_memory_id : null
  });
}

function idleRemainingSeconds(state, now) {
  if (!state || state.interrupted !== true || !state.last_user_activity_at) {
    return 0;
  }

  const idleSeconds = Number(state.idle_resume_seconds || DEFAULT_IDLE_RESUME_SECONDS);
  const elapsed = Math.floor((now.getTime() - new Date(state.last_user_activity_at).getTime()) / 1000);

  return Math.max(0, idleSeconds - elapsed);
}

function buildDreamStatus(options = {}) {
  const env = options.env || process.env;
  const now = nowDate(options);
  const timezone = options.timezone || env.FLOKI_SLEEP_TIMEZONE || yamlTimezone;
  const sleepWindow = getSleepWindowForDate(now, options);
  const within = isWithinSleepWindow(now, options);
  const dreamRoot = getDreamRoot(options);
  const state = loadSleepCycleState(options);
  const stateMatchesWindow = Boolean(state && state.current_sleep_date === sleepWindow.sleep_date);
  const cycles = stateMatchesWindow && Array.isArray(state.rem_cycles)
    ? state.rem_cycles
    : buildRemSchedule(sleepWindow, options);
  const counts = cycleCounts(cycles);
  const interrupted = Boolean(stateMatchesWindow && state.interrupted === true);
  const latest = latestDreamInfo(options);
  const coldStorageAvailable = existsSync(dreamRoot) || existsSync(path.dirname(dreamRoot));
  const currentlySleeping = within && !interrupted;

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_STATUS_PASS',
    current_time_utc: now.toISOString(),
    current_local_time: localTimeString(now, timezone),
    timezone,
    sleep_window: {
      sleep_date: sleepWindow.sleep_date,
      start_at: sleepWindow.start_at,
      end_at: sleepWindow.end_at,
      start_hhmm: sleepWindow.start_hhmm,
      end_hhmm: sleepWindow.end_hhmm,
      crosses_midnight: sleepWindow.crosses_midnight
    },
    currently_sleeping: currentlySleeping,
    within_sleep_window: within,
    currently_interrupted: interrupted,
    idle_seconds_remaining_before_resume: idleRemainingSeconds(state, now),
    idle_resume_seconds: state && state.idle_resume_seconds ? Number(state.idle_resume_seconds) : DEFAULT_IDLE_RESUME_SECONDS,
    rem_cycles_completed_tonight: counts.complete,
    rem_cycles_pending_tonight: counts.pending,
    rem_cycles_dreaming_now: counts.dreaming,
    rem_cycles_total_tonight: counts.total,
    latest_dream_file: latest.latest_dream_file,
    latest_dream_metadata_file: latest.latest_dream_metadata_file,
    latest_dream_title: latest.latest_dream_title,
    latest_dream_memory_written: latest.latest_dream_memory_written,
    latest_dream_memory_id: latest.latest_dream_memory_id,
    dream_count_indexed: latest.dream_count_indexed,
    dream_memory_count_indexed: latest.dream_memory_count_indexed,
    dream_archive_reconciliation: latest.dream_archive_reconciliation,
    dream_root: dreamRoot,
    cold_storage_available: coldStorageAvailable,
    cold_storage_dream_path_used: path.resolve(dreamRoot) === path.resolve(dreamRootFallback),
    dream_index_file: latest.dream_index_file,
    dream_memory_index_file: latest.dream_memory_index_file,
    sleep_state_file_loaded: Boolean(state),
    chat_mode_only: true,
    game_mode_started: false
  });
}

function writeDreamStatusReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const reportFile = options.report_file || path.join(DREAM_STATUS_OUTPUT_DIR, 'latest-dream-status.json');
  ensureParentDirSync(reportFile);
  writeJsonFileAtomicSync(reportFile, status);
  return reportFile;
}

function runDreamStatus(options = {}) {
  const status = buildDreamStatus(options);

  return Object.freeze({
    ...status,
    report_file: writeDreamStatusReport(status, options)
  });
}

function printDreamStatus() {
  const status = runDreamStatus();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  try {
    printDreamStatus();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_DREAM_STATUS_ERROR',
      error: error.message,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  DREAM_STATUS_OUTPUT_DIR,
  buildDreamStatus,
  runDreamStatus,
  writeDreamStatusReport,
  latestDreamInfo
};
