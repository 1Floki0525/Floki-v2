'use strict';

const path = require('node:path');
const {
  statePath,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  existsSync
} = require('../util/fs-safe.cjs');
const { getSleepConfig } = require('../config/floki-config.cjs');

const DEFAULT_STATE_FILE = statePath('chat/sleep/manual-nap-state.json');

function now(options = {}) {
  return options.now ? new Date(options.now) : new Date();
}

function napConfig() {
  const sleep = getSleepConfig('chat');
  const duration = Number(sleep.manual_nap_duration_minutes);
  const interval = Number(sleep.rem_interval_minutes);
  const legacyOffset = Number(sleep.manual_nap_rem_offset_minutes);

  if (duration !== 30) {
    throw new Error('sleep.manual_nap_duration_minutes must remain exactly 30');
  }
  if (interval !== 10) {
    throw new Error('sleep.rem_interval_minutes must remain exactly 10');
  }
  if (legacyOffset !== interval) {
    throw new Error('sleep.manual_nap_rem_offset_minutes must match sleep.rem_interval_minutes');
  }

  return Object.freeze({
    duration_minutes: duration,
    rem_interval_minutes: interval
  });
}

function file(options = {}) {
  return options.state_file || DEFAULT_STATE_FILE;
}

function raw(options = {}) {
  return existsSync(file(options)) ? readJsonFileSync(file(options)) : null;
}

function save(state, options = {}) {
  writeJsonFileAtomicSync(file(options), state);
  return state;
}

function buildRemCycles(startedAt, wakeAt, intervalMinutes, existingCycles = []) {
  const startMs = new Date(startedAt).getTime();
  const wakeMs = new Date(wakeAt).getTime();
  const intervalMs = Number(intervalMinutes) * 60000;

  if (!Number.isFinite(startMs) || !Number.isFinite(wakeMs) || wakeMs <= startMs) {
    throw new Error('manual nap state has invalid start or wake timestamps');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('manual nap REM interval must be positive');
  }

  const existingByTime = new Map(
    (Array.isArray(existingCycles) ? existingCycles : [])
      .filter((cycle) => cycle && typeof cycle.scheduled_at === 'string')
      .map((cycle) => [cycle.scheduled_at, cycle])
  );

  const desiredTimes = [];
  for (let scheduledMs = startMs + intervalMs; scheduledMs < wakeMs; scheduledMs += intervalMs) {
    desiredTimes.push(new Date(scheduledMs).toISOString());
  }

  return desiredTimes.map((scheduledAt, index) => {
    const existing = existingByTime.get(scheduledAt);
    return Object.freeze({
      cycle_number: index + 1,
      scheduled_at: scheduledAt,
      status: existing && existing.status ? existing.status : 'pending',
      dreaming_started_at: existing && existing.dreaming_started_at || null,
      dreaming_process_pid: existing && existing.dreaming_process_pid || null,
      completed_at: existing && existing.completed_at || null,
      dream_txt_file: existing && existing.dream_txt_file || null,
      dream_metadata_file: existing && existing.dream_metadata_file || null,
      last_error: existing && existing.last_error || null,
      last_transition_at: existing && existing.last_transition_at || null
    });
  });
}

function sameSchedule(left, right) {
  const a = Array.isArray(left) ? left.map((cycle) => cycle && cycle.scheduled_at) : [];
  const b = Array.isArray(right) ? right.map((cycle) => cycle && cycle.scheduled_at) : [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function reconcileManualNapState(state, options = {}) {
  if (!state || state.active !== true) return state;

  const cfg = napConfig();
  const desired = buildRemCycles(
    state.started_at,
    state.wake_at,
    cfg.rem_interval_minutes,
    state.rem_cycles
  );

  if (sameSchedule(state.rem_cycles, desired) &&
      Number(state.rem_interval_minutes || cfg.rem_interval_minutes) === cfg.rem_interval_minutes) {
    return state;
  }

  return Object.freeze({
    ...state,
    rem_interval_minutes: cfg.rem_interval_minutes,
    rem_cycles: desired,
    rem_schedule_reconciled_at: now(options).toISOString()
  });
}

function readManualNapState(options = {}) {
  const state = raw(options);
  if (!state) return null;

  const observedAt = now(options);
  if (state.active === true && observedAt >= new Date(state.wake_at)) {
    return save(Object.freeze({
      ...state,
      active: false,
      completed: true,
      completed_at: observedAt.toISOString(),
      wake_reason: 'duration_elapsed',
      last_transition_at: observedAt.toISOString()
    }), options);
  }

  const reconciled = reconcileManualNapState(state, {
    ...options,
    now: observedAt
  });

  return reconciled !== state ? save(reconciled, options) : state;
}

function beginManualNap(options = {}) {
  const cfg = napConfig();
  const at = now(options);
  const current = readManualNapState({ ...options, now: at });
  if (current && current.active === true) return current;

  const wakeAt = new Date(at.getTime() + cfg.duration_minutes * 60000).toISOString();
  return save(Object.freeze({
    kind: 'manual_nap',
    active: true,
    completed: false,
    duration_minutes: cfg.duration_minutes,
    rem_interval_minutes: cfg.rem_interval_minutes,
    started_at: at.toISOString(),
    wake_at: wakeAt,
    last_transition_at: at.toISOString(),
    wake_reason: null,
    consolidation: options.consolidation || null,
    rem_cycles: buildRemCycles(
      at.toISOString(),
      wakeAt,
      cfg.rem_interval_minutes
    ),
    nightly_schedule_modified: false,
    chat_mode_only: true,
    game_mode_started: false
  }), options);
}

function wakeManualNap(reason = 'manual_wake', options = {}) {
  const state = raw(options);
  if (!state || state.active !== true) {
    return state || Object.freeze({
      active: false,
      completed: true,
      wake_reason: 'not_active',
      nightly_schedule_modified: false
    });
  }

  return save(Object.freeze({
    ...state,
    active: false,
    completed: true,
    completed_at: now(options).toISOString(),
    wake_reason: reason,
    last_transition_at: now(options).toISOString()
  }), options);
}

function claimDueRemCycle(options = {}) {
  const state = readManualNapState(options);
  if (!state || state.active !== true) return null;

  const index = state.rem_cycles.findIndex((cycle) => (
    cycle.status === 'pending' &&
    new Date(cycle.scheduled_at) <= now(options)
  ));
  if (index < 0) return null;

  const transitionAt = now(options).toISOString();
  const cycle = Object.freeze({
    ...state.rem_cycles[index],
    status: 'dreaming',
    dreaming_started_at: transitionAt,
    dreaming_process_pid: process.pid,
    last_transition_at: transitionAt
  });
  const next = Object.freeze({
    ...state,
    rem_cycles: state.rem_cycles.map((item, cycleIndex) => (
      cycleIndex === index ? cycle : item
    )),
    last_transition_at: transitionAt
  });

  save(next, options);
  return Object.freeze({ state: next, cycle });
}

function finishRemCycle(result, error, options = {}) {
  const state = raw(options);
  if (!state) return null;

  const transitionAt = now(options).toISOString();
  return save(Object.freeze({
    ...state,
    rem_cycles: state.rem_cycles.map((cycle) => (
      cycle.status !== 'dreaming'
        ? cycle
        : Object.freeze({
            ...cycle,
            status: error ? 'failed' : 'complete',
            dreaming_process_pid: null,
            completed_at: transitionAt,
            dream_txt_file: result && result.dream_txt_file || null,
            dream_metadata_file: result && result.dream_metadata_file || null,
            last_error: error ? error.message : null,
            last_transition_at: transitionAt
          })
    )),
    last_transition_at: transitionAt,
    last_rem_error: error ? error.message : null
  }), options);
}

module.exports = {
  DEFAULT_STATE_FILE,
  napConfig,
  buildRemCycles,
  reconcileManualNapState,
  readManualNapState,
  beginManualNap,
  wakeManualNap,
  claimDueRemCycle,
  finishRemCycle
};
