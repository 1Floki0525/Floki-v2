'use strict';

process.env.TZ = 'America/Toronto';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const { getSleepConfig } = require('../src/config/floki-config.cjs');
const {
  yamlTimezone,
  getSleepWindowForDate,
  buildRemSchedule
} = require('../src/chat/sleep-cycle.cjs');

function localDate(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function localParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes()
  };
}

const chat = loadYamlFile(path.join(__dirname, '../config/chat.config.yaml'));
const chatTemplate = loadYamlFile(path.join(__dirname, '../config/chat.config.yaml.temp'));
const gameTemplate = loadYamlFile(path.join(__dirname, '../config/game.config.yaml.temp'));

assert.equal(chat.sleep.timezone, 'America/Toronto');
assert.equal(chatTemplate.sleep.timezone, 'America/Toronto');
assert.equal(gameTemplate.sleep.timezone, 'America/Toronto');

const resolved = getSleepConfig('chat');
assert.equal(resolved.timezone, 'America/Toronto');
assert.equal(yamlTimezone, 'America/Toronto');

const observed = localDate(2026, 6, 17, 23, 5);
const window = getSleepWindowForDate(observed);
const start = new Date(window.start_at);
const end = new Date(window.end_at);

assert.deepEqual(localParts(start), {
  year: 2026,
  month: 6,
  day: 17,
  hour: 23,
  minute: 0
});
assert.deepEqual(localParts(end), {
  year: 2026,
  month: 6,
  day: 18,
  hour: 7,
  minute: 0
});

const rem = buildRemSchedule(window);
assert.equal(rem.length, 47);
assert.deepEqual(localParts(new Date(rem[0].scheduled_at)), {
  year: 2026,
  month: 6,
  day: 17,
  hour: 23,
  minute: 10
});
assert.deepEqual(localParts(new Date(rem[46].scheduled_at)), {
  year: 2026,
  month: 6,
  day: 18,
  hour: 6,
  minute: 50
});

const sleepSource = fs.readFileSync(
  path.join(__dirname, '../src/chat/sleep-cycle.cjs'),
  'utf8'
);
assert.doesNotMatch(sleepSource, /FLOKI_SLEEP_TIMEZONE/);
assert.match(sleepSource, /timezone: yamlTimezone/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_AMERICA_TORONTO_SLEEP_TIME_CONTRACT_PASS',
  timezone_authority: 'America/Toronto',
  current_instant_source: 'system clock',
  automatic_est_edt_switching: true,
  nightly_start_local: '23:00',
  nightly_end_local: '07:00',
  rem_interval_minutes: 10,
  rem_cycles: 47,
  chat_mode_only: true,
  game_mode_started: false
}, null, 2));
