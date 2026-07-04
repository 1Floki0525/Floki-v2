'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getSleepConfig } = require('../src/config/floki-config.cjs');
const sleepConfig = getSleepConfig('chat');
process.env.TZ = sleepConfig.timezone;

const {
  getSleepWindowForDate,
  buildRemSchedule,
  createSleepCycleState,
  saveSleepCycleState,
  loadSleepCycleState,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');
const {
  beginManualNap
} = require('../src/chat/manual-nap.cjs');
const {
  SCHEDULER_TICK_MS,
  SCHEDULER_HEARTBEAT_STALE_MS,
  SCHEDULER_HEARTBEAT_REFRESH_MS
} = require('../src/chat/sleep-cycle-scheduler.cjs');

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function configuredRemOffsets() {
  return Object.values(sleepConfig.rem_offsets_minutes)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

function expectedNapCycleCount(durationMinutes, firstOffsetMinutes, intervalMinutes, maxCycles) {
  let count = 0;
  for (let offset = firstOffsetMinutes; offset < durationMinutes && count < maxCycles; offset += intervalMinutes) {
    count += 1;
  }
  return count;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rem-runtime-'));
  const stateFile = path.join(root, 'sleep-state.json');
  const eventsFile = path.join(root, 'sleep-events.jsonl');
  const napFile = path.join(root, 'nap-state.json');

  try {
    const observed = localDate(2026, 6, 17, 23, 5);
    const window = getSleepWindowForDate(observed);
    assert.equal(window.timezone, sleepConfig.timezone);
    assert.equal(window.start_hhmm, sleepConfig.start_hhmm);
    assert.equal(window.end_hhmm, sleepConfig.end_hhmm);

    const expectedOffsets = configuredRemOffsets();
    assert.ok(expectedOffsets.length >= 2, 'chat sleep config must provide at least two REM offsets');

    const schedule = buildRemSchedule(window);
    assert.equal(schedule.length, expectedOffsets.length);
    assert.equal(
      new Date(schedule[0].scheduled_at).getTime() - new Date(window.start_at).getTime(),
      expectedOffsets[0] * 60000
    );
    assert.equal(
      new Date(schedule.at(-1).scheduled_at).getTime() - new Date(window.start_at).getTime(),
      expectedOffsets.at(-1) * 60000
    );

    const legacyOffsets = [90, 180, 270, 360, 440];
    const legacy = createSleepCycleState({
      now: observed,
      rem_offsets_minutes: legacyOffsets
    });
    assert.equal(legacy.rem_cycles.length, legacyOffsets.length);
    saveSleepCycleState(legacy, { state_file: stateFile });

    let dreamCalls = 0;
    const dreamRunner = async function(input) {
      dreamCalls += 1;
      return {
        ok: true,
        marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
        dream_txt_file: path.join(root, `dream-${input.rem_cycle_number}.txt`),
        dream_metadata_file: path.join(root, `dream-${input.rem_cycle_number}.json`)
      };
    };

    const firstScheduledAt = new Date(schedule[0].scheduled_at);
    const secondScheduledAt = new Date(schedule[1].scheduled_at);

    const beforeFirst = await runSleepCycleTick({
      env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
      now: new Date(firstScheduledAt.getTime() - 1000),
      state_file: stateFile,
      events_file: eventsFile,
      dream_runner: dreamRunner,
      write_report: false
    });
    assert.equal(beforeFirst.rem_cycles_total, expectedOffsets.length);
    assert.equal(beforeFirst.rem_cycles_completed, 0);
    assert.equal(beforeFirst.rem_cycles_pending, expectedOffsets.length);
    assert.equal(dreamCalls, 0);

    const first = await runSleepCycleTick({
      env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
      now: firstScheduledAt,
      state_file: stateFile,
      events_file: eventsFile,
      dream_runner: dreamRunner,
      write_report: false
    });
    assert.equal(first.rem_cycles_total, expectedOffsets.length);
    assert.equal(first.rem_cycles_completed, 1);
    assert.equal(first.rem_cycles_pending, expectedOffsets.length - 1);
    assert.equal(first.dreams_generated_this_tick, 1);
    assert.equal(dreamCalls, 1);

    const second = await runSleepCycleTick({
      env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
      now: secondScheduledAt,
      state_file: stateFile,
      events_file: eventsFile,
      dream_runner: dreamRunner,
      write_report: false
    });
    assert.equal(second.rem_cycles_completed, 2);
    assert.equal(second.rem_cycles_pending, expectedOffsets.length - 2);
    assert.equal(second.dreams_generated_this_tick, 1);
    assert.equal(dreamCalls, 2);

    const state = loadSleepCycleState({ state_file: stateFile });
    assert.equal(state.rem_interval_minutes, sleepConfig.rem_interval_minutes);
    assert.equal(state.rem_cycles.length, expectedOffsets.length);
    assert.equal(state.rem_cycles[0].status, 'complete');
    assert.equal(state.rem_cycles[1].status, 'complete');
    assert.equal(state.rem_cycles[2].status, 'pending');

    const nap = beginManualNap({
      state_file: napFile,
      now: localDate(2026, 6, 18, 14, 0)
    });
    const expectedNapCycles = expectedNapCycleCount(
      sleepConfig.manual_nap_duration_minutes,
      sleepConfig.manual_nap_rem_offset_minutes,
      sleepConfig.rem_interval_minutes,
      sleepConfig.manual_nap_max_rem_cycles
    );
    assert.equal(nap.duration_minutes, sleepConfig.manual_nap_duration_minutes);
    assert.equal(nap.rem_interval_minutes, sleepConfig.rem_interval_minutes);
    assert.equal(nap.rem_cycles.length, expectedNapCycles);
    assert.equal(
      new Date(nap.rem_cycles[0].scheduled_at).getTime() - new Date(nap.started_at).getTime(),
      sleepConfig.manual_nap_rem_offset_minutes * 60000
    );
    if (nap.rem_cycles.length > 1) {
      assert.equal(
        new Date(nap.rem_cycles[1].scheduled_at).getTime() - new Date(nap.started_at).getTime(),
        (sleepConfig.manual_nap_rem_offset_minutes + sleepConfig.rem_interval_minutes) * 60000
      );
    }
    assert.equal(
      nap.rem_cycles.some((cycle) => cycle.scheduled_at === nap.wake_at),
      false
    );

    assert.equal(SCHEDULER_TICK_MS, sleepConfig.scheduler_tick_ms);
    assert.equal(SCHEDULER_HEARTBEAT_REFRESH_MS, sleepConfig.scheduler_heartbeat_refresh_ms);
    assert.equal(SCHEDULER_HEARTBEAT_STALE_MS, sleepConfig.scheduler_heartbeat_stale_ms);

    const runtimeCommand = fs.readFileSync(
      path.join(__dirname, '../bin/floki-runtime.sh'),
      'utf8'
    );
    const timeline = fs.readFileSync(
      path.join(__dirname, '../src/chat/dream-timeline.cjs'),
      'utf8'
    );
    const dashboard = fs.readFileSync(
      path.join(__dirname, '../apps/floki-neural-interface/src/pages/DreamsDashboard.jsx'),
      'utf8'
    );

    const runtimeStart = runtimeCommand.slice(
      runtimeCommand.indexOf('  start)'),
      runtimeCommand.indexOf('  stop)')
    );
    assert.match(
      runtimeStart,
      /floki-sleep-scheduler-start\.sh/
    );
    assert.match(runtimeStart, /run_helper_if_present/);
    assert.match(timeline, /nextRemCountdownMs/);
    assert.match(timeline, /nextRemCycleNumber/);
    assert.match(dashboard, /COUNTDOWN_INTERVAL_MS = 1000/);
    assert.match(dashboard, /Next REM in/);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_NIGHTLY_REM_RUNTIME_INTEGRATION_PASS',
      timezone: sleepConfig.timezone,
      nightly_window: `${sleepConfig.start_hhmm}-${sleepConfig.end_hhmm}`,
      rem_interval_minutes: sleepConfig.rem_interval_minutes,
      nightly_rem_cycles: expectedOffsets.length,
      first_rem_at_minutes: expectedOffsets[0],
      second_rem_at_minutes: expectedOffsets[1],
      scheduler_tick_ms: SCHEDULER_TICK_MS,
      scheduler_heartbeat_refresh_ms: SCHEDULER_HEARTBEAT_REFRESH_MS,
      scheduler_heartbeat_stale_ms: SCHEDULER_HEARTBEAT_STALE_MS,
      scheduler_values_from_yaml: true,
      nightly_countdown_visible: true,
      nap_rem_cycles: expectedNapCycles,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_NIGHTLY_REM_RUNTIME_INTEGRATION_FAIL',
    error: error.stack || error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
