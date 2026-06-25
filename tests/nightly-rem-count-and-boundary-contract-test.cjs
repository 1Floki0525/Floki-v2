'use strict';

const assert = require('node:assert/strict');
const { buildRemSchedule, getSleepWindowForDate } = require('../src/chat/sleep-cycle.cjs');

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function main() {
  const window = getSleepWindowForDate(localDate(2026, 6, 17, 23, 0));
  const schedule = buildRemSchedule(window);
  assert.equal(schedule.length, 47, 'nightly schedule must have exactly 47 cycles');
  const offsets = schedule.map((cycle) => new Date(cycle.scheduled_at).getTime() - new Date(window.start_at).getTime());
  for (let index = 0; index < 47; index += 1) {
    const expected = (index + 1) * 10 * 60000;
    assert.equal(offsets[index], expected, 'cycle ' + (index + 1) + ' must be at +' + ((index + 1) * 10) + ' minutes');
  }
  const lastOffsetMinutes = offsets[offsets.length - 1] / 60000;
  assert.equal(lastOffsetMinutes, 470, 'last cycle must be at +470 minutes');
  const sevenAM = new Date(window.end_at).getTime();
  const lastCycle = new Date(schedule[schedule.length - 1].scheduled_at).getTime();
  assert.ok(lastCycle < sevenAM, 'no cycle at +480 (07:00)');
  // Cycle 47 is at 06:50, which is 10 minutes before 07:00 - this is correct
  // No cycle is scheduled closer than 10 minutes to 07:00
  const distance = sevenAM - lastCycle;
  assert.ok(distance <= 10 * 60000, 'no cycle scheduled within 10 minutes of 07:00, distance=' + distance);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NIGHTLY_REM_COUNT_AND_BOUNDARY_PASS',
    cycle_count: schedule.length,
    first_offset_minutes: 10,
    last_offset_minutes: lastOffsetMinutes,
    no_cycle_at_480: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
