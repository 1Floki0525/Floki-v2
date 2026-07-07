'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  statePath,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  existsSync
} = require('../util/fs-safe.cjs');
const { getSleepConfig, getDreamConfig } = require('../config/floki-config.cjs');
const { computeBackoffSeconds } = require('./dream-novelty.cjs');
const {
  readDreamEngineControl
} = require('./dream-engine-control.cjs');

const DEFAULT_STATE_FILE = statePath('chat/sleep/manual-nap-state.json');

function isDreamQualityRetry(error) {
  return String(error && error.message || error).startsWith('DREAM_QUALITY_CONTRACT_REJECTED_AFTER_');
}

function now(options = {}) {
  return options.now ? new Date(options.now) : new Date();
}

function napConfig(options = {}) {
  const sleep = options.sleep_config || getSleepConfig('chat');
  const duration = Number(sleep.manual_nap_duration_minutes);
  const interval = Number(sleep.rem_interval_minutes);
  const legacyOffset = Number(sleep.manual_nap_rem_offset_minutes);
  const maxRemCycles = Number(sleep.manual_nap_max_rem_cycles);
  const maxRetry = Number(sleep.manual_nap_dream_max_retry_count);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('sleep.manual_nap_duration_minutes must be greater than zero');
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('sleep.rem_interval_minutes must be greater than zero');
  }
  if (!Number.isFinite(legacyOffset) || legacyOffset < 0 || legacyOffset >= duration) {
    throw new Error('sleep.manual_nap_rem_offset_minutes must be zero or greater and earlier than the configured nap end');
  }
  if (!Number.isFinite(maxRemCycles) || maxRemCycles < 1) {
    throw new Error('sleep.manual_nap_max_rem_cycles must be at least 1');
  }
  if (!Number.isFinite(maxRetry) || maxRetry < 0) {
    throw new Error('sleep.manual_nap_dream_max_retry_count must be zero or greater');
  }

  return Object.freeze({
    duration_minutes: duration,
    first_rem_offset_minutes: legacyOffset,
    rem_interval_minutes: interval,
    max_rem_cycles: maxRemCycles,
    max_dream_retry_count: maxRetry
  });
}

function file(options = {}) {
  return options.state_file || DEFAULT_STATE_FILE;
}

function manualNapDreamEngineControl(options = {}) {
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
      )
    });
  }

  const customStateFile = Boolean(
    options.state_file &&
    path.resolve(options.state_file) !==
      path.resolve(DEFAULT_STATE_FILE)
  );
  if (customStateFile) {
    return Object.freeze({
      enabled: true,
      reason: 'isolated_state_default_enabled'
    });
  }

  return readDreamEngineControl({
    runtime_dir: options.runtime_dir
  });
}


function raw(options = {}) {
  return existsSync(file(options)) ? readJsonFileSync(file(options)) : null;
}

function save(state, options = {}) {
  writeJsonFileAtomicSync(file(options), state);
  return state;
}

function buildRemCycles(startedAt, wakeAt, firstOffsetMinutes, intervalMinutes, existingCycles = [], options = {}) {
  const startMs = new Date(startedAt).getTime();
  const wakeMs = new Date(wakeAt).getTime();
  const firstOffsetMs = Number(firstOffsetMinutes) * 60000;
  const intervalMs = Number(intervalMinutes) * 60000;
  const maxCycles = Number(options.max_rem_cycles ?? Number.POSITIVE_INFINITY);

  if (!Number.isFinite(startMs) || !Number.isFinite(wakeMs) || wakeMs <= startMs) {
    throw new Error('manual nap state has invalid start or wake timestamps');
  }
  if (!Number.isFinite(firstOffsetMs) || firstOffsetMs < 0) throw new Error('manual nap first REM offset must be zero or greater');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('manual nap REM interval must be positive');
  }
  if (!(maxCycles > 0) && maxCycles !== Number.POSITIVE_INFINITY) {
    throw new Error('manual nap maximum REM cycles must be positive');
  }

  const existingByTime = new Map(
    (Array.isArray(existingCycles) ? existingCycles : [])
      .filter((cycle) => cycle && typeof cycle.scheduled_at === 'string')
      .map((cycle) => [cycle.scheduled_at, cycle])
  );

  const desiredTimes = [];
  for (let scheduledMs = startMs + firstOffsetMs; scheduledMs < wakeMs && desiredTimes.length < maxCycles; scheduledMs += intervalMs) {
    desiredTimes.push(new Date(scheduledMs).toISOString());
  }

  return desiredTimes.map((scheduledAt, index) => {
    const existing = existingByTime.get(scheduledAt);
    const oldQualityFailure = existing && existing.status === 'failed' &&
      isDreamQualityRetry(existing.last_error);
    return Object.freeze({
      cycle_number: index + 1,
      scheduled_at: scheduledAt,
      status: oldQualityFailure ? 'pending' : existing && existing.status ? existing.status : 'pending',
      stage: oldQualityFailure ? 'pending' : existing && existing.stage ? existing.stage : 'pending',
      dreaming_started_at: oldQualityFailure ? null : existing && existing.dreaming_started_at || null,
      dreaming_process_pid: null,
      completed_at: oldQualityFailure ? null : existing && existing.completed_at || null,
      dream_txt_file: existing && existing.dream_txt_file || null,
      dream_metadata_file: existing && existing.dream_metadata_file || null,
      next_retry_at: existing && existing.next_retry_at || null,
      quality_retry_count: Number(existing && existing.quality_retry_count || 0),
      dream_attempt_count: Number(existing && existing.dream_attempt_count || 0),
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

  const cfg = napConfig(options);
  const desired = buildRemCycles(
    state.started_at,
    state.wake_at,
    cfg.first_rem_offset_minutes,
    cfg.rem_interval_minutes,
    state.rem_cycles,
    { max_rem_cycles: cfg.max_rem_cycles }
  );

  const normalizationChanged = desired.some((cycle, index) => {
    const current = state.rem_cycles[index] || {};
    return cycle.status !== current.status ||
      cycle.next_retry_at !== (current.next_retry_at || null) ||
      Number(cycle.quality_retry_count || 0) !== Number(current.quality_retry_count || 0);
  });

  if (sameSchedule(state.rem_cycles, desired) &&
      Number(state.first_rem_offset_minutes ?? cfg.first_rem_offset_minutes) === cfg.first_rem_offset_minutes &&
      Number(state.rem_interval_minutes || cfg.rem_interval_minutes) === cfg.rem_interval_minutes &&
      !normalizationChanged) {
    return state;
  }

  return Object.freeze({
    ...state,
    first_rem_offset_minutes: cfg.first_rem_offset_minutes,
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
  const cfg = napConfig(options);
  const at = now(options);
  const current = readManualNapState({ ...options, now: at });
  const requestedSessionId = String(options.runtime_session_id || '').trim() || null;
  const replaceActive = options.replace_active === true;

  if (current && current.active === true) {
    const sameRuntimeSession = Boolean(
      requestedSessionId && current.runtime_session_id === requestedSessionId
    );

    if (!replaceActive || sameRuntimeSession) return current;
  }

  const wakeAt = new Date(at.getTime() + cfg.duration_minutes * 60000).toISOString();
  return save(Object.freeze({
    kind: 'manual_nap',
    active: true,
    runtime_session_id: requestedSessionId,
    completed: false,
    duration_minutes: cfg.duration_minutes,
    first_rem_offset_minutes: cfg.first_rem_offset_minutes,
    rem_interval_minutes: cfg.rem_interval_minutes,
    started_at: at.toISOString(),
    wake_at: wakeAt,
    last_transition_at: at.toISOString(),
    wake_reason: null,
    consolidation: options.consolidation || null,
    rem_cycles: buildRemCycles(
      at.toISOString(),
      wakeAt,
      cfg.first_rem_offset_minutes,
      cfg.rem_interval_minutes,
      [],
      { max_rem_cycles: cfg.max_rem_cycles }
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

  const completed = save(Object.freeze({
    ...state,
    active: false,
    completed: true,
    completed_at: now(options).toISOString(),
    wake_reason: reason,
    last_transition_at: now(options).toISOString()
  }), options);
  if (options.preserve_completed_history !== true) {
    try {
      fs.rmSync(file(options), { force: true });
    } catch (_error) {
      // ignore - file may have been removed externally
    }
  }
  return completed;
}

function claimDueRemCycle(options = {}) {
  const dreamControl = manualNapDreamEngineControl(options);
  if (dreamControl.enabled !== true) return null;

  const state = readManualNapState(options);
  if (!state || state.active !== true) return null;

  const observedAt = now(options);
  const index = state.rem_cycles.findIndex((cycle) => cycle.status !== 'complete');
  if (index < 0) return null;
  const candidate = state.rem_cycles[index];
  if (candidate.status !== 'pending') return null;
  if (new Date(candidate.scheduled_at) > observedAt) return null;
  if (candidate.next_retry_at && new Date(candidate.next_retry_at) > observedAt) return null;

  const transitionAt = now(options).toISOString();
  const cycle = Object.freeze({
    ...state.rem_cycles[index],
    status: 'dreaming',
    stage: 'generating',
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
  const dreamConfig = options.dream_config || getDreamConfig('chat');
  const qualityRetry = Boolean(
    (result && result.regeneration_needed) ||
    (error && isDreamQualityRetry(error))
  );

  return save(Object.freeze({
    ...state,
    rem_cycles: state.rem_cycles.map((cycle) => (
      cycle.status !== 'dreaming'
        ? cycle
        : Object.freeze({
            ...cycle,
            status: qualityRetry ? 'pending' : error ? 'pending' : 'complete',
            stage: qualityRetry ? 'regenerating' : error ? 'error' : 'complete',
            dreaming_started_at: qualityRetry || error ? null : cycle.dreaming_started_at,
            dreaming_process_pid: null,
            completed_at: error || qualityRetry || !result ? null : transitionAt,
            next_retry_at: qualityRetry
              ? new Date(new Date(transitionAt).getTime() + computeBackoffSeconds(Number(cycle.quality_retry_count || 0) + 1, dreamConfig) * 1000).toISOString()
              : null,
            quality_retry_count: qualityRetry
              ? Number(cycle.quality_retry_count || 0) + 1
              : Number(cycle.quality_retry_count || 0),
            dream_txt_file: result && result.dream_txt_file || null,
            dream_metadata_file: result && result.dream_metadata_file || null,
            last_error: error ? error.message : (result && result.last_error ? result.last_error : null),
            last_transition_at: transitionAt
          })
    )),
    last_transition_at: transitionAt,
    last_rem_error: error && !qualityRetry ? error.message : null,
    last_quality_retry: qualityRetry ? (result && result.last_error ? result.last_error : (error ? error.message : null)) : null
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
  manualNapDreamEngineControl,
  claimDueRemCycle,
  finishRemCycle,
  isDreamQualityRetry
};
