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

const { PROJECT_ROOT: ROOT, getSleepConfig } = require('../config/floki-config.cjs');
const SLEEP_CYCLE_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'sleep-cycle');

function getSleepDefaults(mode) {
  const cfg = getSleepConfig(mode || 'chat');
  return Object.freeze({
    timezone: cfg.timezone,
    start_hhmm: cfg.start_hhmm,
    end_hhmm: cfg.end_hhmm,
    idle_resume_seconds: cfg.idle_resume_seconds,
    rem_offsets_minutes: cfg.rem_offsets_minutes
  });
}

const DEFAULTS = getSleepDefaults('chat');
const yamlTimezone = DEFAULTS.timezone;
const sleepStartFallback = DEFAULTS.start_hhmm;
const sleepEndFallback = DEFAULTS.end_hhmm;
const DEFAULT_IDLE_RESUME_SECONDS = DEFAULTS.idle_resume_seconds;
const DEFAULT_REM_OFFSETS_MINUTES = Object.freeze([90, 180, 270, 360, 440]);
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
  const env = options.env || process.env;
  return Object.freeze({
    timezone: options.timezone || env.FLOKI_SLEEP_TIMEZONE || yamlTimezone,
    start: parseHHMM(options.sleep_start_hhmm || env.FLOKI_SLEEP_START_HHMM, sleepStartFallback),
    end: parseHHMM(options.sleep_end_hhmm || env.FLOKI_SLEEP_END_HHMM, sleepEndFallback),
    idle_resume_seconds: Number(options.idle_resume_seconds || env.FLOKI_SLEEP_IDLE_RESUME_SECONDS || DEFAULT_IDLE_RESUME_SECONDS)
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
  const offsets = Array.isArray(options.rem_offsets_minutes) ? options.rem_offsets_minutes : DEFAULT_REM_OFFSETS_MINUTES;
  const startMs = new Date(sleepWindow.start_at).getTime();
  const endMs = new Date(sleepWindow.end_at).getTime();
  return offsets
    .map((minutes, index) => ({
      cycle_number: index + 1,
      scheduled_at: new Date(startMs + Number(minutes) * 60000).toISOString(),
      status: 'pending',
      dream_txt_file: null,
      dream_metadata_file: null,
      dreaming_started_at: null,
      dreaming_process_pid: null,
      completed_at: null,
      last_transition_at: null
    }))
    .filter((cycle) => new Date(cycle.scheduled_at).getTime() < endMs)
    .map(Object.freeze);
}

function stateFile(options = {}) {
  return options.state_file || DEFAULT_STATE_FILE;
}

function eventsFile(options = {}) {
  return options.events_file || DEFAULT_EVENTS_FILE;
}

function createSleepCycleState(options = {}) {
  const now = nowDate(options);
  const window = options.sleep_window || getSleepWindowForDate(now, options);
  const createdAt = now.toISOString();
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
    idle_resume_seconds: getScheduleConfig(options).idle_resume_seconds,
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
  const nextCycles = state.rem_cycles.map((cycle) => {
    if (!cycle || cycle.status !== 'dreaming') return cycle;
    if (alive(Number(cycle.dreaming_process_pid || 0))) return cycle;

    recoveredCycles.push(cycle.cycle_number);
    return Object.freeze({
      ...cycle,
      status: 'pending',
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

  const dreamRunner = options.dream_runner || runDreamEngineOnce;
  let dreamsGenerated = 0;

  for (let cycleIndex = 0; cycleIndex < state.rem_cycles.length; cycleIndex += 1) {
    const cycle = state.rem_cycles[cycleIndex];
    if (cycle.status !== 'pending' || new Date(cycle.scheduled_at) > now) {
      continue;
    }

    const transitionAt = now.toISOString();
    const dreamingCycle = Object.freeze({
      ...cycle,
      status: 'dreaming',
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
        rem_cycle_number: cycle.cycle_number,
        sleep_window_start: state.sleep_window_start,
        sleep_window_end: state.sleep_window_end
      });
    } catch (error) {
      const errorAt = nowDate(options).toISOString();
      state = Object.freeze({
        ...state,
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

    if (!dream || dream.ok !== true || !dream.dream_txt_file) {
      const error = new Error(dream && dream.marker ? dream.marker : 'dream engine did not complete');
      const errorAt = nowDate(options).toISOString();
      state = Object.freeze({
        ...state,
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
  sleepCycleAllowed,
  sleepCycleGuardStatus,
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  createSleepCycleState,
  loadSleepCycleState,
  saveSleepCycleState,
  appendSleepEvent,
  processIsAlive,
  recoverStaleDreamingCycles,
  markAwakeInterruption,
  shouldResumeSleepAfterIdle,
  recordWakeActivityIfSleeping,
  runSleepCycleTick,
  printSleepCycleProof
};
