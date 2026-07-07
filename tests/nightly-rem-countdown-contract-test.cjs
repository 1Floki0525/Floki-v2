'use strict';

process.env.TZ = 'America/Toronto';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDreamTimeline } = require('../src/chat/dream-timeline.cjs');

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

const startDate = localDate(2026, 6, 17, 23, 0);
const endDate = localDate(2026, 6, 18, 7, 0);
const observed = localDate(2026, 6, 17, 23, 5);
const start = startDate.toISOString();
const end = endDate.toISOString();
const cycles = Array.from({ length: 47 }, (_, index) => ({
  cycle_number: index + 1,
  scheduled_at: new Date(startDate.getTime() + (index + 1) * 10 * 60000).toISOString(),
  status: 'pending',
  dreaming_started_at: null,
  dreaming_process_pid: null,
  completed_at: null,
  dream_txt_file: null,
  dream_metadata_file: null,
  last_transition_at: null
}));

const timeline = buildDreamTimeline({
  now: observed,
  dream_status: {
    dream_index_file: '/tmp/nonexistent-dream-index.jsonl',
    dream_root: '/tmp/Floki-memory-bank/dreams',
    latest_dream_title: null
  },
  lifecycle_status: {
    state: 'asleep',
    is_awake: false,
    is_asleep: true,
    is_dreaming: false,
    is_rem_dreaming: false,
    sleep_window_start: start,
    sleep_window_end: end,
    current_rem_cycle_number: null,
    current_rem_started_at: null,
    next_rem_cycle_number: 1,
    next_rem_cycle_at: cycles[0].scheduled_at,
    last_architecture_error: null
  },
  manual_nap_state: null,
  sleep_cycle_state: {
    current_sleep_date: '2026-06-17',
    sleep_window_start: start,
    sleep_window_end: end,
    active: true,
    completed: false,
    timezone: 'America/Toronto',
    rem_interval_minutes: 10,
    rem_cycles: cycles
  },
  records: []
});

assert.equal(timeline.activeSession.kind, 'nightly_sleep');
assert.equal(timeline.activeSession.active, true);
assert.equal(timeline.activeSession.remIntervalMinutes, 10);
assert.equal(timeline.activeSession.nextRemCycleNumber, 1);
assert.equal(timeline.activeSession.nextRemCycleAt, cycles[0].scheduled_at);
assert.equal(timeline.activeSession.nextRemCountdownMs, 5 * 60000);
assert.equal(timeline.cycles.length, 47);
assert.equal(timeline.cycles[0].status, 'pending');
assert.equal(timeline.cycles[46].cycleNumber, 47);

const dashboard = fs.readFileSync(
  path.join(__dirname, '../apps/floki-neural-interface/src/pages/DreamsDashboard.jsx'),
  'utf8'
);
assert.match(dashboard, /COUNTDOWN_INTERVAL_MS = 1000/);
assert.match(dashboard, /getSelfImprovementStatus/);
assert.match(dashboard, /nightly_cycle/);
assert.match(dashboard, /completed_epochs/);
assert.match(dashboard, /completed_rem_cycles/);
assert.match(dashboard, /next_action/);
assert.match(dashboard, /Wake countdown/);
assert.match(
  dashboard,
  /One complete HF training epoch, then one REM dream, repeating until 07:00 America\/Toronto/
);
assert.match(dashboard, /One adapter candidate is compiled for review at wake/);
assert.doesNotMatch(dashboard, /One REM dream every/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_NIGHTLY_REM_COUNTDOWN_CONTRACT_PASS',
  timezone: 'America/Toronto',
  nightly_rem_cycles: timeline.cycles.length,
  rem_interval_minutes: timeline.activeSession.remIntervalMinutes,
  next_rem_countdown_ms: timeline.activeSession.nextRemCountdownMs,
  chat_mode_only: true,
  game_mode_started: false
}, null, 2));
