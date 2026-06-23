'use strict';

const {
  getSleepConfig
} = require('../config/floki-config.cjs');
const {
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  loadSleepCycleState
} = require('./sleep-cycle.cjs');
const {
  readSchedulerRuntimeStatus
} = require('./sleep-cycle-scheduler.cjs');
const { readManualNapState } = require('./manual-nap.cjs');

const LIFECYCLE_MARKER = 'FLOKI_V2_LIFECYCLE_STATUS_PASS';

const DISPLAY_LABELS = Object.freeze({
  awake: 'AWAKE',
  awake_sleep_interrupted: 'AWAKE — SLEEP INTERRUPTED',
  asleep: 'ASLEEP',
  rem_dreaming: 'REM DREAMING',
  manual_nap: 'ASLEEP — 30-MINUTE NAP',
  manual_nap_rem: 'REM DREAMING — MANUAL NAP',
  unknown: 'UNKNOWN'
});

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function sleepOptionsFromConfig(mode) {
  const sleep = getSleepConfig(mode || 'chat');
  return Object.freeze({
    timezone: sleep.timezone,
    sleep_start_hhmm: sleep.start_hhmm,
    sleep_end_hhmm: sleep.end_hhmm,
    idle_resume_seconds: sleep.idle_resume_seconds,
    rem_interval_minutes: sleep.rem_interval_minutes
  });
}

function validDateString(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return Number.isFinite(new Date(value).getTime());
}

function findCurrentRemCycle(cycles, processAlive) {
  const dreaming = (Array.isArray(cycles) ? cycles : []).find((cycle) => cycle && cycle.status === 'dreaming');
  if (!dreaming) {
    return Object.freeze({
      cycle: null,
      process_alive: false,
      stale: false
    });
  }

  const pid = Number(dreaming.dreaming_process_pid || dreaming.current_rem_process_pid || 0);
  const alive = processAlive(pid);
  const hasStartedAt = validDateString(dreaming.dreaming_started_at || dreaming.current_rem_started_at);

  return Object.freeze({
    cycle: dreaming,
    process_alive: alive,
    stale: hasStartedAt && !alive
  });
}

function findNextRemCycle(cycles, now) {
  const nowMs = asDate(now).getTime();
  const pending = (Array.isArray(cycles) ? cycles : [])
    .filter((cycle) => cycle && cycle.status === 'pending')
    .sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime());
  return pending.find((cycle) => new Date(cycle.scheduled_at).getTime() >= nowMs) || pending[0] || null;
}

function chooseLastTransitionAt(state, remCycle, observedAt) {
  if (remCycle && remCycle.last_transition_at) return remCycle.last_transition_at;
  if (state && state.last_transition_at) return state.last_transition_at;
  if (state && state.interrupted_at) return state.interrupted_at;
  if (state && Array.isArray(state.rem_cycles)) {
    const transitioned = state.rem_cycles
      .filter((cycle) => cycle && (cycle.last_transition_at || cycle.completed_at || cycle.dreaming_started_at))
      .sort((left, right) => {
        const leftAt = left.last_transition_at || left.completed_at || left.dreaming_started_at;
        const rightAt = right.last_transition_at || right.completed_at || right.dreaming_started_at;
        return new Date(rightAt).getTime() - new Date(leftAt).getTime();
      })[0];
    if (transitioned) return transitioned.last_transition_at || transitioned.completed_at || transitioned.dreaming_started_at;
  }
  return observedAt;
}

function buildUnknownStatus(reason, base) {
  return Object.freeze({
    ...base,
    state: 'unknown',
    display_label: DISPLAY_LABELS.unknown,
    is_awake: false,
    is_asleep: false,
    is_dreaming: false,
    is_rem_dreaming: false,
    source_of_truth: 'corrupt_sleep_cycle_state',
    unknown_reason: reason
  });
}

function buildFlokiLifecycleStatus(options = {}) {
  const mode = options.mode || 'chat';
  const now = asDate(options.now || new Date());
  const observedAt = now.toISOString();
  const sleepOptions = Object.freeze({
    ...sleepOptionsFromConfig(mode),
    ...options
  });
  const processAlive = options.process_is_alive || processIsAlive;
  const schedulerStatus = options.scheduler_status || readSchedulerRuntimeStatus({
    now,
    process_is_alive: options.scheduler_process_is_alive
  });
  const sleepWindow = getSleepWindowForDate(now, sleepOptions);
  const manualNap = options.manual_nap_state || readManualNapState({ now });
  const withinSleepWindow = isWithinSleepWindow(now, sleepOptions);
  const savedState = options.sleep_cycle_state || loadSleepCycleState(options);
  const stateLoaded = savedState !== null && savedState !== undefined;
  const stateRemCycles = stateLoaded && Array.isArray(savedState.rem_cycles)
    ? savedState.rem_cycles
    : buildRemSchedule(sleepWindow, sleepOptions);
  const currentRem = findCurrentRemCycle(stateRemCycles, processAlive);
  const currentRemCycle = currentRem.cycle;
  const activeRemVerified = withinSleepWindow &&
    currentRemCycle &&
    currentRemCycle.status === 'dreaming' &&
    validDateString(currentRemCycle.dreaming_started_at) &&
    currentRem.process_alive === true;
  const nextRem = findNextRemCycle(stateRemCycles, now);
  const lastTransitionAt = chooseLastTransitionAt(savedState, currentRemCycle, observedAt);
  const activeStateDateMatches = !stateLoaded || savedState.current_sleep_date === sleepWindow.sleep_date;
  const sleepInterrupted = stateLoaded && savedState.interrupted === true && activeStateDateMatches;
  const sleepCycleActive = withinSleepWindow &&
    (!stateLoaded || (savedState.active !== false && savedState.completed !== true)) &&
    activeStateDateMatches;

  const base = Object.freeze({
    ok: true,
    marker: LIFECYCLE_MARKER,
    within_sleep_window: withinSleepWindow,
    sleep_cycle_active: sleepCycleActive,
    sleep_cycle_state_loaded: stateLoaded,
    sleep_interrupted: sleepInterrupted,
    current_rem_cycle_number: currentRemCycle && activeRemVerified ? currentRemCycle.cycle_number : null,
    current_rem_started_at: currentRemCycle && activeRemVerified ? currentRemCycle.dreaming_started_at : null,
    current_rem_process_pid: currentRemCycle ? Number(currentRemCycle.dreaming_process_pid || 0) || null : null,
    current_rem_process_alive: currentRem.process_alive,
    next_rem_cycle_number: nextRem ? nextRem.cycle_number : null,
    next_rem_cycle_at: nextRem ? nextRem.scheduled_at : null,
    sleep_window_start: sleepWindow.start_at,
    sleep_window_end: sleepWindow.end_at,
    sleep_window_label: sleepWindow.start_hhmm + '-' + sleepWindow.end_hhmm + ' ' + sleepWindow.timezone,
    sleep_window_timezone: sleepWindow.timezone,
    last_transition_at: lastTransitionAt,
    observed_at: observedAt,
    source_of_truth: stateLoaded ? 'sleep_cycle_state' : 'sleep_window_schedule',
    stale_dreaming_state_detected: currentRem.stale === true,
    stale_rem_cycle_number: currentRem.stale === true && currentRemCycle ? currentRemCycle.cycle_number : null,
    sleep_cycle_scheduler_running: schedulerStatus.active === true,
    sleep_cycle_scheduler_status: schedulerStatus,
    sleep_cycle_scheduler_note: schedulerStatus.active === true
      ? 'Continuous sleep-cycle scheduler is active.'
      : 'Continuous sleep-cycle scheduler is inactive.',
    chat_mode_only: true,
    game_mode_started: false
  });

  if (manualNap && manualNap.active === true) {
    const dreaming = (manualNap.rem_cycles || []).find((cycle) => cycle.status === 'dreaming');
    const pending = (manualNap.rem_cycles || []).find((cycle) => cycle.status === 'pending');
    return Object.freeze({ ...base, state: dreaming ? 'rem_dreaming' : 'asleep', display_label: dreaming ? DISPLAY_LABELS.manual_nap_rem : DISPLAY_LABELS.manual_nap, is_awake: false, is_asleep: true, is_dreaming: Boolean(dreaming), is_rem_dreaming: Boolean(dreaming), source_of_truth: 'manual_nap_state', manual_nap_active: true, manual_nap_started_at: manualNap.started_at, manual_nap_wake_at: manualNap.wake_at, manual_nap_duration_minutes: manualNap.duration_minutes, manual_nap_rem_cycles: manualNap.rem_cycles || [], current_rem_cycle_number: dreaming ? dreaming.cycle_number : null, current_rem_started_at: dreaming ? dreaming.dreaming_started_at : null, next_rem_cycle_number: pending ? pending.cycle_number : null, next_rem_cycle_at: pending ? pending.scheduled_at : null, last_transition_at: manualNap.last_transition_at || manualNap.started_at, nightly_schedule_modified: false });
  }

  if (stateLoaded && (!Array.isArray(savedState.rem_cycles) || !validDateString(savedState.sleep_window_start) || !validDateString(savedState.sleep_window_end))) {
    return buildUnknownStatus('sleep cycle state is missing required window or REM fields', base);
  }

  if (withinSleepWindow && sleepInterrupted) {
    return Object.freeze({
      ...base,
      state: 'awake_sleep_interrupted',
      display_label: DISPLAY_LABELS.awake_sleep_interrupted,
      is_awake: true,
      is_asleep: false,
      is_dreaming: false,
      is_rem_dreaming: false,
      source_of_truth: 'sleep_cycle_state'
    });
  }

  if (activeRemVerified) {
    return Object.freeze({
      ...base,
      state: 'rem_dreaming',
      display_label: DISPLAY_LABELS.rem_dreaming,
      is_awake: false,
      is_asleep: true,
      is_dreaming: true,
      is_rem_dreaming: true,
      source_of_truth: 'sleep_cycle_state'
    });
  }

  if (withinSleepWindow) {
    return Object.freeze({
      ...base,
      state: 'asleep',
      display_label: DISPLAY_LABELS.asleep,
      is_awake: false,
      is_asleep: true,
      is_dreaming: false,
      is_rem_dreaming: false
    });
  }

  return Object.freeze({
    ...base,
    state: 'awake',
    display_label: DISPLAY_LABELS.awake,
    is_awake: true,
    is_asleep: false,
    is_dreaming: false,
    is_rem_dreaming: false
  });
}

function formatLifecycleStateLine(status) {
  const suffix = status && status.state === 'rem_dreaming' && status.current_rem_cycle_number
    ? ' (cycle ' + status.current_rem_cycle_number + ')'
    : '';
  return 'Floki state: ' + (status && status.display_label ? status.display_label : DISPLAY_LABELS.unknown) + suffix;
}

function lifecycleTransitionLabel(status) {
  if (!status) return DISPLAY_LABELS.unknown;
  const suffix = status.state === 'rem_dreaming' && status.current_rem_cycle_number
    ? ' (cycle ' + status.current_rem_cycle_number + ')'
    : '';
  return status.display_label + suffix;
}

function formatLifecycleHumanSummary(status) {
  const lines = [formatLifecycleStateLine(status)];
  lines.push('Sleep window: ' + status.sleep_window_label);
  if (status.state === 'rem_dreaming') {
    lines.push('Current REM started: ' + status.current_rem_started_at);
    lines.push('Next transition: dream completion or wake activity');
  } else if (status.state === 'awake') {
    lines.push('Next sleep window begins: ' + status.sleep_window_start);
  } else if (status.state === 'awake_sleep_interrupted') {
    lines.push('Sleep resumes after idle: configured by sleep.idle_resume_seconds');
  } else if (status.state === 'asleep' && status.next_rem_cycle_at) {
    lines.push('Next REM cycle: ' + status.next_rem_cycle_at);
  }
  if (status.stale_dreaming_state_detected) {
    lines.push('Warning: stale REM dreaming state detected for cycle ' + status.stale_rem_cycle_number);
  }
  lines.push('Sleep-cycle scheduler: ' + (status.sleep_cycle_scheduler_running ? 'active' : 'inactive'));
  return lines.join('\n');
}

function printLifecycleStatus(options = {}) {
  const status = buildFlokiLifecycleStatus(options);
  console.log(formatLifecycleHumanSummary(status));
  console.log(JSON.stringify(status, null, 2));
  return status;
}

if (require.main === module) {
  printLifecycleStatus();
}

module.exports = {
  LIFECYCLE_MARKER,
  DISPLAY_LABELS,
  processIsAlive,
  buildFlokiLifecycleStatus,
  formatLifecycleStateLine,
  lifecycleTransitionLabel,
  formatLifecycleHumanSummary,
  printLifecycleStatus
};
