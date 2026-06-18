'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  yamlTimezone,
  getSleepWindowForDate,
  isWithinSleepWindow,
  buildRemSchedule,
  createSleepCycleState,
  loadSleepCycleState,
  markAwakeInterruption,
  shouldResumeSleepAfterIdle,
  runSleepCycleTick
} = require('../src/chat/sleep-cycle.cjs');

async function run() {
  const unique = newId('sleep_cycle_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/sleep-cycle/' + unique);
  const stateFile = path.join(baseDir, 'sleep-cycle-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  ensureDirSync(baseDir);

  const windowAtNight = getSleepWindowForDate(new Date('2026-06-18T03:30:00.000Z'), {
    timezone: yamlTimezone
  });
  assert.equal(windowAtNight.timezone, yamlTimezone);
  assert.equal(windowAtNight.sleep_date, '2026-06-17');
  assert.equal(windowAtNight.start_hhmm, '23:00');
  assert.equal(windowAtNight.end_hhmm, '07:00');
  assert.equal(windowAtNight.crosses_midnight, true);
  assert.equal(isWithinSleepWindow(new Date('2026-06-18T03:30:00.000Z')), true);
  assert.equal(isWithinSleepWindow(new Date('2026-06-18T12:00:00.000Z')), false);

  const rem = buildRemSchedule(windowAtNight);
  assert.equal(rem.length, 5);
  assert.equal(rem[0].cycle_number, 1);
  assert.equal(rem[0].scheduled_at, '2026-06-18T04:30:00.000Z');
  assert.equal(rem[4].scheduled_at, '2026-06-18T10:20:00.000Z');

  const initial = createSleepCycleState({
    now: '2026-06-18T03:30:00.000Z'
  });
  assert.equal(initial.active, true);
  assert.equal(initial.completed, false);
  assert.equal(initial.idle_resume_seconds, 120);
  assert.equal(initial.rem_cycles.length, 5);

  const interrupted = markAwakeInterruption(initial, 'wake_gated_user_activity', {
    now: '2026-06-18T04:00:00.000Z',
    events_file: eventsFile
  });
  assert.equal(interrupted.interrupted, true);
  assert.equal(shouldResumeSleepAfterIdle(interrupted, '2026-06-18T04:01:59.000Z'), false);
  assert.equal(shouldResumeSleepAfterIdle(interrupted, '2026-06-18T04:02:00.000Z'), true);

  let dreamCalls = 0;
  const tick = await runSleepCycleTick({
    env: {
      FLOKI_ALLOW_SLEEP_CYCLE: '1'
    },
    now: '2026-06-18T04:31:00.000Z',
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
  assert.equal(tick.rem_cycles_total, 5);
  assert.equal(tick.rem_cycles_completed, 1);
  assert.equal(tick.rem_cycles_pending, 4);
  assert.equal(tick.dreams_generated_this_tick, 1);
  assert.equal(tick.dream_files_written.length, 1);
  assert.equal(dreamCalls, 1);
  assert.equal(tick.chat_mode_only, true);
  assert.equal(tick.game_mode_started, false);

  const saved = loadSleepCycleState({ state_file: stateFile });
  assert.equal(saved.rem_cycles[0].status, 'complete');
  assert.equal(saved.rem_cycles[1].status, 'pending');
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.existsSync(eventsFile), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS',
    sleep_cycle_active: tick.sleep_cycle_active,
    sleep_window_start: tick.sleep_window_start,
    sleep_window_end: tick.sleep_window_end,
    within_sleep_window: tick.within_sleep_window,
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
    marker: 'FLOKI_V2_SLEEP_CYCLE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
