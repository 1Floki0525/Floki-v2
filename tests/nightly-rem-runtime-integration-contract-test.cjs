'use strict';

process.env.TZ = 'America/Toronto';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rem-runtime-'));
  const stateFile = path.join(root, 'sleep-state.json');
  const eventsFile = path.join(root, 'sleep-events.jsonl');
  const napFile = path.join(root, 'nap-state.json');

  const observed = localDate(2026, 6, 17, 23, 5);
  const window = getSleepWindowForDate(observed);
  assert.equal(window.timezone, 'America/Toronto');
  assert.equal(window.start_hhmm, '23:00');
  assert.equal(window.end_hhmm, '07:00');

  const schedule = buildRemSchedule(window);
  assert.equal(schedule.length, 47);
  assert.equal(
    new Date(schedule[0].scheduled_at).getTime() -
      new Date(window.start_at).getTime(),
    10 * 60000
  );
  assert.equal(
    new Date(schedule[46].scheduled_at).getTime() -
      new Date(window.start_at).getTime(),
    470 * 60000
  );

  const legacy = createSleepCycleState({
    now: observed,
    rem_offsets_minutes: [90, 180, 270, 360, 440]
  });
  assert.equal(legacy.rem_cycles.length, 5);
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

  const beforeFirst = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: localDate(2026, 6, 17, 23, 9, 59),
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: dreamRunner,
    write_report: false
  });
  assert.equal(beforeFirst.rem_cycles_total, 47);
  assert.equal(beforeFirst.rem_cycles_completed, 0);
  assert.equal(beforeFirst.rem_cycles_pending, 47);
  assert.equal(dreamCalls, 0);

  const first = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: localDate(2026, 6, 17, 23, 10),
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: dreamRunner,
    write_report: false
  });
  assert.equal(first.rem_cycles_total, 47);
  assert.equal(first.rem_cycles_completed, 1);
  assert.equal(first.rem_cycles_pending, 46);
  assert.equal(first.dreams_generated_this_tick, 1);
  assert.equal(dreamCalls, 1);

  const second = await runSleepCycleTick({
    env: { FLOKI_ALLOW_SLEEP_CYCLE: '1' },
    now: localDate(2026, 6, 17, 23, 20),
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: dreamRunner,
    write_report: false
  });
  assert.equal(second.rem_cycles_completed, 2);
  assert.equal(second.rem_cycles_pending, 45);
  assert.equal(second.dreams_generated_this_tick, 1);
  assert.equal(dreamCalls, 2);

  const state = loadSleepCycleState({ state_file: stateFile });
  assert.equal(state.rem_interval_minutes, 10);
  assert.equal(state.rem_cycles.length, 47);
  assert.equal(state.rem_cycles[0].status, 'complete');
  assert.equal(state.rem_cycles[1].status, 'complete');
  assert.equal(state.rem_cycles[2].status, 'pending');

  const nap = beginManualNap({
    state_file: napFile,
    now: localDate(2026, 6, 18, 14, 0)
  });
  assert.equal(nap.duration_minutes, 30);
  assert.equal(nap.rem_interval_minutes, 10);
  assert.equal(nap.rem_cycles.length, 2);
  assert.equal(
    new Date(nap.rem_cycles[0].scheduled_at).getTime() -
      new Date(nap.started_at).getTime(),
    10 * 60000
  );
  assert.equal(
    new Date(nap.rem_cycles[1].scheduled_at).getTime() -
      new Date(nap.started_at).getTime(),
    20 * 60000
  );

  const scheduler = fs.readFileSync(
    path.join(__dirname, '../src/chat/sleep-cycle-scheduler.cjs'),
    'utf8'
  );
  const start = fs.readFileSync(
    path.join(__dirname, '../bin/floki-start.sh'),
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

  assert.match(scheduler, /SCHEDULER_TICK_MS = 30000/);
  assert.match(start, /chat\.local\)[\s\S]*start_sleep_scheduler/);
  assert.match(start, /verify_sleep_scheduler/);
  assert.match(timeline, /nextRemCountdownMs/);
  assert.match(timeline, /nextRemCycleNumber/);
  assert.match(dashboard, /COUNTDOWN_INTERVAL_MS = 1000/);
  assert.match(dashboard, /Next REM in/);
  assert.match(dashboard, /America\/Toronto/);

  fs.rmSync(root, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NIGHTLY_REM_RUNTIME_INTEGRATION_PASS',
    timezone: 'America/Toronto',
    nightly_window: '23:00-07:00',
    rem_interval_minutes: 10,
    nightly_rem_cycles: 47,
    first_rem_at_minutes: 10,
    second_rem_at_minutes: 20,
    scheduler_tick_ms: 30000,
    nightly_countdown_visible: true,
    nap_rem_cycles: 2,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_NIGHTLY_REM_RUNTIME_INTEGRATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
