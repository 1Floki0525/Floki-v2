'use strict';

process.env.TZ = 'America/Toronto';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { getSleepConfig } = require('../src/config/floki-config.cjs');
const {
  yamlTimezone,
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  createSleepCycleState,
  loadSleepCycleState,
  saveSleepCycleState,
  markAwakeInterruption,
  shouldResumeSleepAfterIdle,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function localClock(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0')
  ].join(':');
}

async function run() {
  const unique = newId('sleep_cycle_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-cycle/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  ensureDirSync(baseDir);

  const sleepConfig = getSleepConfig('chat');
  assert.equal(sleepConfig.timezone, 'America/Toronto');
  assert.equal(yamlTimezone, 'America/Toronto');
  assert.equal(sleepConfig.rem_interval_minutes, 10);

  const observed = localDate(2026, 6, 17, 23, 30);
  const windowAtNight = getSleepWindowForDate(observed);
  assert.equal(windowAtNight.timezone, 'America/Toronto');
  assert.equal(windowAtNight.sleep_date, '2026-06-17');
  assert.equal(windowAtNight.start_hhmm, '23:00');
  assert.equal(windowAtNight.end_hhmm, '07:00');
  assert.equal(windowAtNight.crosses_midnight, true);
  assert.equal(isWithinSleepWindow(observed), true);
  assert.equal(isWithinSleepWindow(localDate(2026, 6, 18, 12, 0)), false);
  assert.equal(localClock(new Date(windowAtNight.start_at)), '23:00');
  assert.equal(localClock(new Date(windowAtNight.end_at)), '07:00');

  const rem = buildRemSchedule(windowAtNight);
  assert.equal(rem.length, 47);
  assert.equal(rem[0].cycle_number, 1);
  assert.equal(localClock(new Date(rem[0].scheduled_at)), '23:10');
  assert.equal(localClock(new Date(rem[1].scheduled_at)), '23:20');
  assert.equal(localClock(new Date(rem[46].scheduled_at)), '06:50');
  for (let index = 1; index < rem.length; index += 1) {
    assert.equal(
      new Date(rem[index].scheduled_at).getTime() -
        new Date(rem[index - 1].scheduled_at).getTime(),
      10 * 60000
    );
  }

  const initial = createSleepCycleState({
    now: localDate(2026, 6, 17, 23, 5)
  });
  assert.equal(initial.active, true);
  assert.equal(initial.completed, false);
  assert.equal(initial.idle_resume_seconds, 120);
  assert.equal(initial.rem_interval_minutes, 10);
  assert.equal(initial.rem_cycles.length, 47);

  const interrupted = markAwakeInterruption(initial, 'wake_gated_user_activity', {
    now: localDate(2026, 6, 17, 23, 6),
    events_file: eventsFile
  });
  assert.equal(interrupted.interrupted, true);
  assert.equal(
    shouldResumeSleepAfterIdle(
      interrupted,
      localDate(2026, 6, 17, 23, 7, 59)
    ),
    false
  );
  assert.equal(
    shouldResumeSleepAfterIdle(
      interrupted,
      localDate(2026, 6, 17, 23, 8, 0)
    ),
    true
  );

  const legacy = createSleepCycleState({
    now: localDate(2026, 6, 17, 23, 5),
    rem_offsets_minutes: [90, 180, 270, 360, 440]
  });
  assert.equal(legacy.rem_cycles.length, 5);
  saveSleepCycleState(legacy, {
    state_file: stateFile
  });

  let dreamCalls = 0;
  const tick = await runSleepCycleTick({
    env: {
      FLOKI_ALLOW_SLEEP_CYCLE: '1'
    },
    now: localDate(2026, 6, 17, 23, 11),
    state_file: stateFile,
    events_file: eventsFile,
    dream_runner: async function(input) {
      dreamCalls += 1;
      assert.equal(input.rem_cycle_number, 1);
      return {
        ok: true,
        marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
        dream_txt_file: path.join(baseDir, 'dream-1.txt'),
        dream_metadata_file: path.join(baseDir, 'dream-1.json')
      };
    },
    write_report: false
  });

  assert.equal(tick.ok, true);
  assert.equal(tick.marker, 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS');
  assert.equal(tick.sleep_cycle_active, true);
  assert.equal(tick.within_sleep_window, true);
  assert.equal(tick.rem_cycles_total, 47);
  assert.equal(tick.rem_cycles_completed, 1);
  assert.equal(tick.rem_cycles_pending, 46);
  assert.equal(tick.dreams_generated_this_tick, 1);
  assert.equal(tick.dream_files_written.length, 1);
  assert.equal(dreamCalls, 1);
  assert.equal(tick.chat_mode_only, true);
  assert.equal(tick.game_mode_started, false);

  const saved = loadSleepCycleState({
    state_file: stateFile
  });
  assert.equal(saved.timezone, 'America/Toronto');
  assert.equal(saved.rem_interval_minutes, 10);
  assert.equal(saved.rem_cycles.length, 47);
  assert.equal(saved.rem_cycles[0].status, 'complete');
  assert.equal(saved.rem_cycles[1].status, 'pending');
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.existsSync(eventsFile), true);

  fs.rmSync(baseDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_TEN_MINUTE_REM_CADENCE_PASS',
    timezone: 'America/Toronto',
    rem_interval_minutes: 10,
    rem_cycles_total: tick.rem_cycles_total,
    rem_cycles_completed: tick.rem_cycles_completed,
    rem_cycles_pending: tick.rem_cycles_pending,
    dreams_generated_this_tick: tick.dreams_generated_this_tick,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_TEN_MINUTE_REM_CADENCE_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
