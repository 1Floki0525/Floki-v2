'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  statePath,
  ensureParentDirSync,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  existsSync
} = require('../util/fs-safe.cjs');
const { appendJsonlSync } = require('../util/jsonl.cjs');
const { runDreamEngineOnce } = require('./dream-engine.cjs');
const {
  readDreamEngineControl
} = require('./dream-engine-control.cjs');
const { computeBackoffSeconds } = require('./dream-novelty.cjs');
const { runPreRemMemoryPreparation } = require('./pre-rem-memory-preparation.cjs');

const { PROJECT_ROOT: ROOT, getSleepConfig, getDreamConfig } = require('../config/floki-config.cjs');
const SLEEP_CYCLE_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'sleep-cycle');

function getSleepDefaults(mode) {
  const cfg = getSleepConfig(mode || 'chat');
  return Object.freeze({
    timezone: cfg.timezone,
    start_hhmm: cfg.start_hhmm,
    end_hhmm: cfg.end_hhmm,
    idle_resume_seconds: cfg.idle_resume_seconds,
    rem_interval_minutes: cfg.rem_interval_minutes,
    rem_offsets_minutes: cfg.rem_offsets_minutes
  });
}

const DEFAULTS = getSleepDefaults('chat');
const yamlTimezone = DEFAULTS.timezone;
const sleepStartFallback = DEFAULTS.start_hhmm;
const sleepEndFallback = DEFAULTS.end_hhmm;
const DEFAULT_IDLE_RESUME_SECONDS = DEFAULTS.idle_resume_seconds;
const DEFAULT_REM_INTERVAL_MINUTES = DEFAULTS.rem_interval_minutes;

function isDreamQualityRetry(error) {
  return String(error && error.message || error).startsWith('DREAM_QUALITY_CONTRACT_REJECTED_AFTER_');
}
const DEFAULT_STATE_FILE = statePath('chat/sleep/sleep-cycle-state.json');
const DEFAULT_EVENTS_FILE = statePath('chat/sleep/sleep-events.jsonl');

function sleepCycleAllowed(env = process.env) {
  return env.FLOKI_ALLOW_SLEEP_CYCLE === '1';
}

function sleepCycleGuardStatus(env = process.env) {
  const allowed = sleepCycleAllowed(env);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_SLEEP_CYCLE=1',
    sleep_cycle_run_now: false,
    dream_generation_run_now: false,
    cold_storage_write_now: false,
    chat_mode_only: true,
    game_mode_started: false,
    reason: allowed
      ? 'Sleep cycle is explicitly allowed for this run.'
      : 'Sleep cycle is guarded and will not write state or generate dreams without FLOKI_ALLOW_SLEEP_CYCLE=1.'
  });
}

function nowDate(options = {}) {
  if (options.now) return new Date(options.now);
  const env = options.env || process.env;
  if (env.FLOKI_SLEEP_TEST_NOW) return new Date(env.FLOKI_SLEEP_TEST_NOW);
  return new Date();
}

function parseHHMM(value, fallback) {
  const raw = String(value || fallback || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error('invalid HH:MM value: ' + raw);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('invalid HH:MM value: ' + raw);
  }
  return Object.freeze({
    text: raw,
    hour,
    minute,
    minutes: hour * 60 + minute
  });
}

function getScheduleConfig(options = {}) {
  return Object.freeze({
    timezone: yamlTimezone,
    start: parseHHMM(options.sleep_start_hhmm, sleepStartFallback),
    end: parseHHMM(options.sleep_end_hhmm, sleepEndFallback),
    idle_resume_seconds: Number(
      options.idle_resume_seconds || DEFAULT_IDLE_RESUME_SECONDS
    ),
    rem_interval_minutes: Number(
      options.rem_interval_minutes || DEFAULT_REM_INTERVAL_MINUTES
    )
  });
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return Object.freeze(out);
}

function dateKey(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return Object.freeze({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  });
}

function zonedLocalToUtc(local, timezone) {
  let guess = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0));
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(guess, timezone);
    const desiredUtcMinutes = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0) / 60000;
    const actualUtcMinutes = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0) / 60000;
    const diffMinutes = desiredUtcMinutes - actualUtcMinutes;
    if (diffMinutes === 0) break;
    guess = new Date(guess.getTime() + diffMinutes * 60000);
  }
  return guess;
}

function getSleepWindowForDate(date, options = {}) {
  const config = getScheduleConfig(options);
  const current = date instanceof Date ? date : new Date(date);
  const parts = zonedParts(current, config.timezone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const crossesMidnight = config.end.minutes <= config.start.minutes;
  let startDay = { year: parts.year, month: parts.month, day: parts.day };
  let endDay = { year: parts.year, month: parts.month, day: parts.day };

  if (crossesMidnight) {
    if (currentMinutes < config.end.minutes) {
      startDay = addLocalDays(parts, -1);
      endDay = { year: parts.year, month: parts.month, day: parts.day };
    } else {
      endDay = addLocalDays(parts, 1);
    }
  } else if (currentMinutes < config.start.minutes) {
    startDay = addLocalDays(parts, -1);
    endDay = addLocalDays(parts, -1);
  }

  const startAt = zonedLocalToUtc({
    ...startDay,
    hour: config.start.hour,
    minute: config.start.minute
  }, config.timezone);
  const endAt = zonedLocalToUtc({
    ...endDay,
    hour: config.end.hour,
    minute: config.end.minute
  }, config.timezone);

  return Object.freeze({
    timezone: config.timezone,
    sleep_date: dateKey(startDay),
    start_hhmm: config.start.text,
    end_hhmm: config.end.text,
    start_at: startAt.toISOString(),
    end_at: endAt.toISOString(),
    crosses_midnight: crossesMidnight
  });
}

function isWithinSleepWindow(date, options = {}) {
  const now = date instanceof Date ? date : new Date(date);
  const window = getSleepWindowForDate(now, options);
  return now >= new Date(window.start_at) && now < new Date(window.end_at);
}

function buildRemSchedule(sleepWindow, options = {}) {
  const startMs = new Date(sleepWindow.start_at).getTime();
  const endMs = new Date(sleepWindow.end_at).getTime();
  const explicitOffsets = Array.isArray(options.rem_offsets_minutes)
    ? options.rem_offsets_minutes.map(Number)
    : null;
  const intervalMinutes = Number(
    options.rem_interval_minutes || DEFAULT_REM_INTERVAL_MINUTES
  );

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('sleep window contains invalid timestamps');
  }

  let offsets;
  if (explicitOffsets) {
    offsets = explicitOffsets;
  } else {
    if (!Number.isFinite(intervalMinutes) || intervalMinutes !== 10) {
      throw new Error('sleep.rem_interval_minutes must be 10');
    }
    offsets = [];
    for (
      let offset = intervalMinutes;
      startMs + offset * 60000 < endMs;
      offset += intervalMinutes
    ) {
      offsets.push(offset);
    }
  }

  return offsets
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
    .sort((left, right) => left - right)
    .map((minutes, index) => Object.freeze({
      cycle_number: index + 1,
      scheduled_at: new Date(startMs + minutes * 60000).toISOString(),
      status: 'pending',
      stage: 'pending',
      dream_txt_file: null,
      dream_metadata_file: null,
      dreaming_started_at: null,
      dreaming_process_pid: null,
      completed_at: null,
      last_transition_at: null,
      quality_retry_count: 0,
      dream_attempt_count: 0,
      next_retry_at: null
    }))
    .filter((cycle) => new Date(cycle.scheduled_at).getTime() < endMs);
}

function sameRemSchedule(left, right) {
  const leftTimes = Array.isArray(left)
    ? left.map((cycle) => cycle && cycle.scheduled_at)
    : [];
  const rightTimes = Array.isArray(right)
    ? right.map((cycle) => cycle && cycle.scheduled_at)
    : [];
  return leftTimes.length === rightTimes.length &&
    leftTimes.every((value, index) => value === rightTimes[index]);
}

function reconcileRemSchedule(state, sleepWindow, options = {}) {
  if (!state || !Array.isArray(state.rem_cycles)) return state;

  const desired = buildRemSchedule(sleepWindow, options);
  const intervalMinutes = Number(
    options.rem_interval_minutes || DEFAULT_REM_INTERVAL_MINUTES
  );

  if (
    sameRemSchedule(state.rem_cycles, desired) &&
    Number(state.rem_interval_minutes || intervalMinutes) === intervalMinutes
  ) {
    return state;
  }

  const existingByTime = new Map(
    state.rem_cycles
      .filter((cycle) => cycle && typeof cycle.scheduled_at === 'string')
      .map((cycle) => [cycle.scheduled_at, cycle])
  );

  const merged = desired.map((cycle, index) => {
    const existing = existingByTime.get(cycle.scheduled_at);
    if (!existing) return cycle;
    const oldQualityFailure = existing.status === 'failed' &&
      isDreamQualityRetry(existing.last_error || existing.last_attempt_error);
    return Object.freeze({
      ...cycle,
      ...existing,
      cycle_number: index + 1,
      scheduled_at: cycle.scheduled_at,
      status: oldQualityFailure ? 'pending' : (existing.status || 'pending'),
      stage: oldQualityFailure ? 'pending' : (existing.stage || 'pending'),
      dreaming_started_at: oldQualityFailure ? null : existing.dreaming_started_at || null,
      dreaming_process_pid: oldQualityFailure ? null : existing.dreaming_process_pid || null,
      completed_at: oldQualityFailure ? null : existing.completed_at || null,
      next_retry_at: oldQualityFailure ? null : existing.next_retry_at || null
    });
  });

  return Object.freeze({
    ...state,
    timezone: sleepWindow.timezone,
    sleep_window_start: sleepWindow.start_at,
    sleep_window_end: sleepWindow.end_at,
    rem_interval_minutes: intervalMinutes,
    rem_cycles: merged,
    rem_schedule_reconciled_at: nowDate(options).toISOString()
  });
}

function stateFile(options = {}) {
  return options.state_file || DEFAULT_STATE_FILE;
}

function eventsFile(options = {}) {
  return options.events_file || DEFAULT_EVENTS_FILE;
}

function dreamEngineControlForTick(options = {}) {
  if (
    Object.prototype.hasOwnProperty.call(
      options,
      'dream_engine_control'
    )
  ) {
    const provided = options.dream_engine_control || {};
    return Object.freeze({
      enabled: provided.enabled !== false,
      reason: String(
        provided.reason || 'provided_by_caller'
      ),
      control_file: provided.control_file || null
    });
  }

  const customStateFile = (
    options.state_file &&
    path.resolve(options.state_file) !==
      path.resolve(DEFAULT_STATE_FILE)
  );
  if (customStateFile) {
    return Object.freeze({
      enabled: true,
      reason: 'isolated_state_default_enabled',
      control_file: null
    });
  }

  return readDreamEngineControl({
    runtime_dir: options.runtime_dir
  });
}


function createSleepCycleState(options = {}) {
  const now = nowDate(options);
  const window = options.sleep_window || getSleepWindowForDate(now, options);
  const createdAt = now.toISOString();
  const schedule = getScheduleConfig(options);

  return Object.freeze({
    current_sleep_date: window.sleep_date,
    sleep_window_start: window.start_at,
    sleep_window_end: window.end_at,
    timezone: window.timezone,
    active: true,
    completed: false,
    interrupted: false,
    interrupted_at: null,
    last_user_activity_at: null,
    last_transition_at: createdAt,
    idle_resume_seconds: schedule.idle_resume_seconds,
    rem_interval_minutes: schedule.rem_interval_minutes,
    rem_cycles: buildRemSchedule(window, options),
    resumed_after_interruption_count: 0,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function loadSleepCycleState(options = {}) {
  const file = stateFile(options);
  if (!existsSync(file)) return null;
  return readJsonFileSync(file);
}

function saveSleepCycleState(state, options = {}) {
  writeJsonFileAtomicSync(stateFile(options), state);
  return state;
}

async function ensurePreRemMemoryConsolidation(state, options = {}) {
  if (state && state.pre_rem_memory_consolidation && state.pre_rem_memory_consolidation.completed === true) {
    return Object.freeze({ state, ran_now: false, result: state.pre_rem_memory_consolidation });
  }
  const preparationRunner = options.pre_rem_memory_preparation_runner || runPreRemMemoryPreparation;
  const customStateFile = options.state_file && path.resolve(options.state_file) !== path.resolve(DEFAULT_STATE_FILE);
  const isolatedRoot = customStateFile
    ? path.join(path.dirname(path.resolve(options.state_file)), 'pre-rem-knowledge')
    : null;
  const knowledgeOptions = options.knowledge_options || (isolatedRoot ? {
    text_root: path.join(isolatedRoot, 'text'),
    youtube_root: path.join(isolatedRoot, 'text', 'youtube'),
    knowledge_root: path.join(isolatedRoot, 'knowledge'),
    memory_base_dir: path.join(isolatedRoot, 'memory'),
    runtime_dir: path.join(isolatedRoot, 'runtime'),
    stamp_file: path.join(isolatedRoot, 'runtime', 'knowledge-autoload.last-run')
  } : {});
  const prepared = await Promise.resolve(preparationRunner({
    ...knowledgeOptions,
    write_report: options.write_report,
    knowledge_consolidation_report_file: options.knowledge_consolidation_report_file,
    knowledge_autoload_runner: options.knowledge_autoload_runner,
    knowledge_memory_consolidation_runner: options.knowledge_memory_consolidation_runner
  }));
  if (!prepared || prepared.ok !== true) {
    throw new Error('nightly pre-REM memory preparation failed');
  }
  const completedAt = nowDate(options).toISOString();
  const record = Object.freeze({
    completed: true,
    completed_at: completedAt,
    autoload_marker: prepared.autoload && prepared.autoload.marker || null,
    source_count: Number(prepared.source_count || 0),
    chunk_count: Number(prepared.chunk_count || 0),
    scanned_file_count: Number(prepared.scanned_file_count || 0),
    unchanged_source_count: Number(prepared.unchanged_source_count || 0),
    memories_written: Number(prepared.memories_written || 0),
    short_term_memories_promoted: Number(prepared.short_term_memories_promoted || 0)
  });
  const nextState = Object.freeze({
    ...state,
    pre_rem_memory_consolidation: record,
    last_transition_at: completedAt
  });
  saveSleepCycleState(nextState, options);
  appendSleepEvent({
    type: 'pre_rem_memory_consolidation_complete',
    ...record,
    at: completedAt
  }, options);
  return Object.freeze({ state: nextState, ran_now: true, result: record });
}

function appendSleepEvent(record, options = {}) {
  appendJsonlSync(eventsFile(options), {
    ...record,
    created_at: record.created_at || new Date().toISOString(),
    chat_mode_only: true,
    game_mode_started: false
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

function recoverStaleDreamingCycles(state, options = {}) {
  if (!state || !Array.isArray(state.rem_cycles)) {
    return Object.freeze({ state, recovered: false, recovered_cycles: [] });
  }

  const alive = options.process_is_alive || processIsAlive;
  const at = nowDate(options).toISOString();
  const recoveredCycles = [];
  const STALE_GENERATING_STAGES = new Set([
    'claimed',
    'gathering_context',
    'planning_novelty',
    'generating',
    'validating'
  ]);

  const nextCycles = state.rem_cycles.map((cycle) => {
    if (!cycle) return cycle;
    const isDreaming = cycle.status === 'dreaming';
    const isStaleStage = STALE_GENERATING_STAGES.has(cycle.stage);
    const pidAlive = alive(Number(cycle.dreaming_process_pid || 0));

    if (!isDreaming && !isStaleStage) return cycle;
    if (pidAlive) return cycle;

    recoveredCycles.push(cycle.cycle_number);
    return Object.freeze({
      ...cycle,
      status: 'pending',
      stage: 'pending',
      dreaming_started_at: null,
      dreaming_process_pid: null,
      last_transition_at: at
    });
  });

  if (recoveredCycles.length === 0) {
    return Object.freeze({ state, recovered: false, recovered_cycles: [] });
  }

  const nextState = Object.freeze({
    ...state,
    rem_cycles: nextCycles,
    last_transition_at: at
  });

  for (const cycleNumber of recoveredCycles) {
    appendSleepEvent({
      type: 'rem_dream_requeued_after_scheduler_restart',
      rem_cycle_number: cycleNumber,
      at
    }, options);
  }

  return Object.freeze({
    state: nextState,
    recovered: true,
    recovered_cycles: recoveredCycles
  });
}

function markAwakeInterruption(state, reason, options = {}) {
  const at = nowDate(options).toISOString();
  const next = Object.freeze({
    ...state,
    active: true,
    interrupted: true,
    interrupted_at: state.interrupted_at || at,
    last_user_activity_at: at,
    last_transition_at: at,
    interruption_reason: reason || 'wake_gated_user_activity'
  });
  if (options.write_event !== false) {
    appendSleepEvent({
      type: 'sleep_interrupted',
      reason: reason || 'wake_gated_user_activity',
      at
    }, options);
  }
  return next;
}

function shouldResumeSleepAfterIdle(state, now, options = {}) {
  if (!state || state.interrupted !== true || !state.last_user_activity_at) return false;
  const idleSeconds = Number(options.idle_resume_seconds || state.idle_resume_seconds || DEFAULT_IDLE_RESUME_SECONDS);
  const elapsed = (new Date(now).getTime() - new Date(state.last_user_activity_at).getTime()) / 1000;
  return elapsed >= idleSeconds;
}

function recordWakeActivityIfSleeping(options = {}) {
  const env = options.env || process.env;
  if (!sleepCycleAllowed(env)) {
    return Object.freeze({
      ok: true,
      sleep_interrupted_by_wake: false,
      sleep_cycle_active: false,
      reason: 'sleep_cycle_guarded',
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const now = nowDate(options);
  if (!isWithinSleepWindow(now, options)) {
    return Object.freeze({
      ok: true,
      sleep_interrupted_by_wake: false,
      sleep_cycle_active: false,
      reason: 'outside_sleep_window',
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const sleepWindow = getSleepWindowForDate(now, options);
  let state = loadSleepCycleState(options);
  if (!state || state.current_sleep_date !== sleepWindow.sleep_date || state.completed === true) {
    state = createSleepCycleState({ ...options, sleep_window: sleepWindow });
  }
  state = reconcileRemSchedule(state, sleepWindow, options);
  const interrupted = markAwakeInterruption(state, options.reason || 'wake_gated_user_activity', options);
  saveSleepCycleState(interrupted, options);

  return Object.freeze({
    ok: true,
    sleep_interrupted_by_wake: true,
    sleep_cycle_active: true,
    current_sleep_date: interrupted.current_sleep_date,
    sleep_window_start: interrupted.sleep_window_start,
    sleep_window_end: interrupted.sleep_window_end,
    last_user_activity_at: interrupted.last_user_activity_at,
    rem_cycles_preserved_after_interruption: Array.isArray(interrupted.rem_cycles),
    chat_mode_only: true,
    game_mode_started: false
  });
}

function countCycles(state, status) {
  return (state.rem_cycles || []).filter((cycle) => cycle.status === status).length;
}

function writeSleepCycleReport(status, options = {}) {
  if (options.write_report === false) return null;
  const reportFile = options.report_file || path.join(SLEEP_CYCLE_OUTPUT_DIR, 'latest-sleep-cycle.json');
  ensureParentDirSync(reportFile);
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
}

async function runSleepCycleTick(options = {}) {
  const env = options.env || process.env;
  const guard = sleepCycleGuardStatus(env);
  const now = nowDate(options);

  if (!guard.allowed_now) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_SLEEP_CYCLE_BLOCKED',
      guard,
      sleep_cycle_active: false,
      sleep_window_start: null,
      sleep_window_end: null,
      within_sleep_window: false,
      rem_cycles_total: 0,
      rem_cycles_completed: 0,
      rem_cycles_pending: 0,
      interrupted_now: false,
      resumed_after_idle: false,
      idle_resume_seconds: DEFAULT_IDLE_RESUME_SECONDS,
      dreams_generated_this_tick: 0,
      dream_files_written: [],
      chat_mode_only: true,
      game_mode_started: false
    });
    return Object.freeze({
      ...status,
      report_file: writeSleepCycleReport(status, options)
    });
  }

  const sleepWindow = getSleepWindowForDate(now, options);
  const within = isWithinSleepWindow(now, options);
  let state = loadSleepCycleState(options);
  let stateDirty = false;
  let interruptedNow = false;
  let resumedAfterIdle = false;
  const dreamFilesWritten = [];

  if (!within) {
    if (state && state.active === true) {
      state = Object.freeze({
        ...state,
        active: false,
        completed: true,
        last_transition_at: now.toISOString()
      });
      saveSleepCycleState(state, options);
    }
    const outState = state || createSleepCycleState({ ...options, sleep_window: sleepWindow });
    const status = Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
      sleep_cycle_active: false,
      sleep_window_start: sleepWindow.start_at,
      sleep_window_end: sleepWindow.end_at,
      within_sleep_window: false,
      rem_cycles_total: outState.rem_cycles.length,
      rem_cycles_completed: countCycles(outState, 'complete'),
      rem_cycles_pending: countCycles(outState, 'pending'),
      interrupted_now: false,
      resumed_after_idle: false,
      idle_resume_seconds: outState.idle_resume_seconds,
      dreams_generated_this_tick: 0,
      dream_files_written: [],
      chat_mode_only: true,
      game_mode_started: false
    });
    return Object.freeze({
      ...status,
      report_file: writeSleepCycleReport(status, options)
    });
  }

  if (!state || state.current_sleep_date !== sleepWindow.sleep_date || state.completed === true) {
    state = createSleepCycleState({ ...options, sleep_window: sleepWindow });
    stateDirty = true;
    appendSleepEvent({ type: 'sleep_window_started', sleep_date: sleepWindow.sleep_date, at: now.toISOString() }, options);
  }

  const reconciledSchedule = reconcileRemSchedule(state, sleepWindow, options);
  if (reconciledSchedule !== state) {
    state = reconciledSchedule;
    stateDirty = true;
    appendSleepEvent({
      type: 'rem_schedule_reconciled',
      rem_interval_minutes: state.rem_interval_minutes,
      rem_cycles_total: state.rem_cycles.length,
      at: now.toISOString()
    }, options);
  }

  const recovered = recoverStaleDreamingCycles(state, options);
  if (recovered.recovered) {
    state = recovered.state;
    stateDirty = true;
  }

  if (options.user_activity_reason) {
    state = markAwakeInterruption(state, options.user_activity_reason, options);
    stateDirty = true;
    interruptedNow = true;
  }

  if (state.interrupted === true) {
    if (shouldResumeSleepAfterIdle(state, now, options)) {
      state = Object.freeze({
        ...state,
        interrupted: false,
        interrupted_at: null,
        last_transition_at: now.toISOString(),
        resumed_after_interruption_count: Number(state.resumed_after_interruption_count || 0) + 1
      });
      stateDirty = true;
      resumedAfterIdle = true;
      appendSleepEvent({ type: 'sleep_resumed_after_idle', at: now.toISOString() }, options);
    } else {
      if (stateDirty) saveSleepCycleState(state, options);
      const pausedStatus = Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
        sleep_cycle_active: true,
        sleep_window_start: state.sleep_window_start,
        sleep_window_end: state.sleep_window_end,
        within_sleep_window: true,
        rem_cycles_total: state.rem_cycles.length,
        rem_cycles_completed: countCycles(state, 'complete'),
        rem_cycles_pending: countCycles(state, 'pending'),
        interrupted_now: interruptedNow,
        resumed_after_idle: false,
        idle_resume_seconds: state.idle_resume_seconds,
        dreams_generated_this_tick: 0,
        dream_files_written: [],
        chat_mode_only: true,
        game_mode_started: false
      });
      return Object.freeze({
        ...pausedStatus,
        report_file: writeSleepCycleReport(pausedStatus, options)
      });
    }
  }

  const dreamControl = dreamEngineControlForTick(options);
  if (dreamControl.enabled !== true) {
    if (stateDirty) saveSleepCycleState(state, options);
    const suspendedStatus = Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
      sleep_cycle_active: true,
      sleep_window_start: state.sleep_window_start,
      sleep_window_end: state.sleep_window_end,
      within_sleep_window: true,
      rem_cycles_total: state.rem_cycles.length,
      rem_cycles_completed: countCycles(state, 'complete'),
      rem_cycles_pending: countCycles(state, 'pending'),
      interrupted_now: interruptedNow,
      resumed_after_idle: resumedAfterIdle,
      idle_resume_seconds: state.idle_resume_seconds,
      pre_rem_memory_consolidation:
        state.pre_rem_memory_consolidation || null,
      dream_engine_enabled: false,
      dream_generation_suspended: true,
      dream_engine_control_reason:
        dreamControl.reason || null,
      dream_engine_control_file:
        dreamControl.control_file || null,
      dreams_generated_this_tick: 0,
      dream_files_written: [],
      chat_mode_only: true,
      game_mode_started: false
    });
    return Object.freeze({
      ...suspendedStatus,
      report_file:
        writeSleepCycleReport(suspendedStatus, options)
    });
  }

  const preRem = await ensurePreRemMemoryConsolidation(state, options);
  state = preRem.state;
  const dreamRunner = options.dream_runner || runDreamEngineOnce;
  let dreamsGenerated = 0;

  for (let cycleIndex = 0; cycleIndex < state.rem_cycles.length; cycleIndex += 1) {
    const cycle = state.rem_cycles[cycleIndex];
    if (cycle.status !== 'pending' || new Date(cycle.scheduled_at) > now || (cycle.next_retry_at && new Date(cycle.next_retry_at) > now)) {
      continue;
    }

    const transitionAt = now.toISOString();
    const dreamingCycle = Object.freeze({
      ...cycle,
      status: 'dreaming',
      stage: 'generating',
      dreaming_started_at: transitionAt,
      dreaming_process_pid: process.pid,
      last_transition_at: transitionAt
    });
    state = Object.freeze({
      ...state,
      rem_cycles: state.rem_cycles.map((item, index) => index === cycleIndex ? dreamingCycle : item),
      last_transition_at: transitionAt
    });
    saveSleepCycleState(state, options);
    appendSleepEvent({
      type: 'rem_dream_started',
      rem_cycle_number: cycle.cycle_number,
      dreaming_started_at: transitionAt,
      dreaming_process_pid: process.pid,
      at: transitionAt
    }, options);

    let dream;
    try {
      dream = await dreamRunner({
        ...options.dream_options,
        env,
        sleep_kind: 'nightly_sleep',
        rem_cycle_number: cycle.cycle_number,
        sleep_window_start: state.sleep_window_start,
        sleep_window_end: state.sleep_window_end
      });
    } catch (error) {
      const errorAt = nowDate(options).toISOString();
      const requeuedCycle = Object.freeze({
        ...dreamingCycle,
        status: 'pending',
        stage: 'pending',
        dreaming_started_at: null,
        dreaming_process_pid: null,
        dream_attempt_count: Number(cycle.dream_attempt_count || 0) + 1,
        last_attempt_error: error.message,
        last_attempt_at: errorAt,
        last_transition_at: errorAt
      });
      state = Object.freeze({
        ...state,
        rem_cycles: state.rem_cycles.map((item, index) => index === cycleIndex ? requeuedCycle : item),
        last_transition_at: errorAt,
        last_architecture_error_at: errorAt,
        last_architecture_error: error.message
      });
      saveSleepCycleState(state, options);
      appendSleepEvent({
        type: 'rem_dream_architecture_error',
        rem_cycle_number: cycle.cycle_number,
        error: error.message,
        at: errorAt
      }, options);
      throw error;
    }

    if (dream && dream.regeneration_needed === true) {
      const errorAt = nowDate(options).toISOString();
      const dreamConfig = getDreamConfig(options.mode || 'chat');
      const nextAttemptCount = Number(cycle.quality_retry_count || 0) + 1;
      const backoffMs = computeBackoffSeconds(nextAttemptCount, dreamConfig) * 1000;
      const requeuedCycle = Object.freeze({
        ...dreamingCycle,
        status: 'pending',
        stage: 'regenerating',
        dreaming_started_at: null,
        dreaming_process_pid: null,
        next_retry_at: new Date(new Date(errorAt).getTime() + backoffMs).toISOString(),
        dream_attempt_count: Number(cycle.dream_attempt_count || 0) + 1,
        quality_retry_count: nextAttemptCount,
        last_attempt_error: dream.last_error || dream.marker,
        last_attempt_at: errorAt,
        last_transition_at: errorAt,
        last_diagnostics: dream.diagnostics || null
      });
      state = Object.freeze({
        ...state,
        rem_cycles: state.rem_cycles.map((item, index) => index === cycleIndex ? requeuedCycle : item),
        last_transition_at: errorAt,
        last_quality_retry_at: errorAt,
        last_quality_retry: dream.last_error || dream.marker,
        last_architecture_error_at: null,
        last_architecture_error: null
      });
      saveSleepCycleState(state, options);
      appendSleepEvent({
        type: 'rem_dream_quality_retry',
        rem_cycle_number: cycle.cycle_number,
        error: dream.last_error || dream.marker,
        retry_at: requeuedCycle.next_retry_at,
        at: errorAt
      }, options);
      continue;
    }

    if (!dream || dream.ok !== true || !dream.dream_txt_file) {
      const error = new Error(dream && dream.marker ? dream.marker : 'dream engine did not complete');
      const errorAt = nowDate(options).toISOString();
      const requeuedCycle = Object.freeze({
        ...dreamingCycle,
        status: 'pending',
        stage: 'pending',
        dreaming_started_at: null,
        dreaming_process_pid: null,
        dream_attempt_count: Number(cycle.dream_attempt_count || 0) + 1,
        last_attempt_error: error.message,
        last_attempt_at: errorAt,
        last_transition_at: errorAt
      });
      state = Object.freeze({
        ...state,
        rem_cycles: state.rem_cycles.map((item, index) => index === cycleIndex ? requeuedCycle : item),
        last_transition_at: errorAt,
        last_architecture_error_at: errorAt,
        last_architecture_error: error.message
      });
      saveSleepCycleState(state, options);
      appendSleepEvent({
        type: 'rem_dream_architecture_error',
        rem_cycle_number: cycle.cycle_number,
        error: error.message,
        at: errorAt
      }, options);
      throw error;
    }

    dreamsGenerated += 1;
    dreamFilesWritten.push(dream.dream_txt_file);
    const completedAt = nowDate(options).toISOString();
    const completedCycle = Object.freeze({
      ...dreamingCycle,
      status: 'complete',
      stage: 'complete',
      dream_txt_file: dream.dream_txt_file,
      dream_metadata_file: dream.dream_metadata_file || null,
      dreaming_process_pid: null,
      completed_at: completedAt,
      last_transition_at: completedAt
    });
    state = Object.freeze({
      ...state,
      rem_cycles: state.rem_cycles.map((item, index) => index === cycleIndex ? completedCycle : item),
      last_transition_at: completedAt,
      last_architecture_error_at: null,
      last_architecture_error: null
    });
    saveSleepCycleState(state, options);
    appendSleepEvent({
      type: 'rem_dream_completed',
      rem_cycle_number: cycle.cycle_number,
      completed_at: completedAt,
      at: completedAt
    }, options);
    stateDirty = false;
  }

  if (stateDirty) saveSleepCycleState(state, options);

  const status = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
    sleep_cycle_active: true,
    sleep_window_start: state.sleep_window_start,
    sleep_window_end: state.sleep_window_end,
    within_sleep_window: true,
    rem_cycles_total: state.rem_cycles.length,
    rem_cycles_completed: countCycles(state, 'complete'),
    rem_cycles_pending: countCycles(state, 'pending'),
    interrupted_now: interruptedNow,
    resumed_after_idle: resumedAfterIdle,
    idle_resume_seconds: state.idle_resume_seconds,
    pre_rem_memory_consolidation: state.pre_rem_memory_consolidation || null,
    dream_engine_enabled: true,
    dream_generation_suspended: false,
    dreams_generated_this_tick: dreamsGenerated,
    dream_files_written: dreamFilesWritten,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: writeSleepCycleReport(status, options)
  });
}

async function printSleepCycleProof() {
  const status = await runSleepCycleTick();
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) process.exitCode = 1;
  return status;
}

if (require.main === module) {
  printSleepCycleProof().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SLEEP_CYCLE_ERROR',
      error: error.message,
      sleep_cycle_active: false,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  SLEEP_CYCLE_OUTPUT_DIR,
  yamlTimezone,
  sleepStartFallback,
  sleepEndFallback,
  DEFAULT_IDLE_RESUME_SECONDS,
  DEFAULT_REM_INTERVAL_MINUTES,
  sleepCycleAllowed,
  sleepCycleGuardStatus,
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  reconcileRemSchedule,
  createSleepCycleState,
  loadSleepCycleState,
  saveSleepCycleState,
  appendSleepEvent,
  processIsAlive,
  recoverStaleDreamingCycles,
  markAwakeInterruption,
  shouldResumeSleepAfterIdle,
  recordWakeActivityIfSleeping,
  ensurePreRemMemoryConsolidation,
  dreamEngineControlForTick,
  runSleepCycleTick,
  printSleepCycleProof
};
