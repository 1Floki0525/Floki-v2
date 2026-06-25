'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const {
  beginManualNap,
  readManualNapState,
  wakeManualNap,
  claimDueRemCycle,
  finishRemCycle
} = require('../src/chat/manual-nap.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-v22-nap-'));
const fixtureFile = path.join(dir, 'chat.config.yaml');
fs.copyFileSync(path.join(__dirname, '../config/chat.config.yaml.temp'), fixtureFile);
const yaml = loadYamlFile(fixtureFile);
const sleep = yaml.sleep;
const stateFile = path.join(dir, 'state.json');
const start = new Date('2026-06-22T15:00:00.000Z');

assert.equal(sleep.manual_nap_duration_minutes, 30);
assert.equal(sleep.rem_interval_minutes, 10);
assert.equal(sleep.manual_nap_rem_offset_minutes, 0);

const legacyState = {
  kind: 'manual_nap', active: true, completed: false, duration_minutes: 30,
  started_at: start.toISOString(),
  wake_at: new Date(start.getTime() + 30 * 60000).toISOString(),
  last_transition_at: start.toISOString(), wake_reason: null,
  rem_cycles: [{ cycle_number: 1, scheduled_at: new Date(start.getTime() + 15 * 60000).toISOString(), status: 'pending' }],
  nightly_schedule_modified: false, chat_mode_only: true, game_mode_started: false
};
fs.writeFileSync(stateFile, JSON.stringify(legacyState, null, 2) + '\n');

const migrated = readManualNapState({ state_file: stateFile, now: start, sleep_config: sleep });
assert.equal(migrated.rem_cycles.length, 3);
assert.deepEqual(migrated.rem_cycles.map((cycle) => new Date(cycle.scheduled_at).getTime() - start.getTime()), [0, 10 * 60000, 20 * 60000]);
assert.equal(migrated.rem_cycles.some((cycle) => new Date(cycle.scheduled_at).getTime() === new Date(migrated.wake_at).getTime()), false);

for (const [cycleNumber, minute] of [[1, 0], [2, 10], [3, 20]]) {
  const claim = claimDueRemCycle({ state_file: stateFile, now: new Date(start.getTime() + minute * 60000), sleep_config: sleep });
  assert.equal(claim.cycle.cycle_number, cycleNumber);
  assert.equal(claim.cycle.status, 'dreaming');
  assert.equal(claimDueRemCycle({ state_file: stateFile, now: new Date(start.getTime() + minute * 60000), sleep_config: sleep }), null);
  finishRemCycle({ dream_txt_file: `/tmp/dream-${cycleNumber}.txt` }, null, {
    state_file: stateFile,
    now: new Date(start.getTime() + (minute * 60000) + 1000),
    sleep_config: sleep
  });
}

const completed = readManualNapState({ state_file: stateFile, now: new Date(start.getTime() + 21 * 60000), sleep_config: sleep });
assert.equal(completed.rem_cycles.filter((cycle) => cycle.status === 'complete').length, 3);
assert.equal(completed.nightly_schedule_modified, false);
assert.equal(wakeManualNap('manual_wake', { state_file: stateFile, now: new Date(start.getTime() + 25 * 60000) }).active, false);

const freshStateFile = path.join(dir, 'fresh-state.json');
const fresh = beginManualNap({ state_file: freshStateFile, now: start, consolidation: { ok: true }, sleep_config: sleep });
assert.equal(fresh.duration_minutes, 30);
assert.equal(fresh.rem_interval_minutes, 10);
assert.equal(fresh.first_rem_offset_minutes, 0);
assert.equal(fresh.rem_cycles.length, 3);
assert.equal(fresh.rem_cycles[0].scheduled_at, start.toISOString());
assert.equal(new Date(fresh.wake_at).getTime() - start.getTime(), 30 * 60000);
assert.equal(fresh.nightly_schedule_modified, false);

fs.rmSync(dir, { recursive: true, force: true });
console.log('FLOKI_V22_MANUAL_NAP_IMMEDIATE_TEN_MINUTE_REM_CONTRACT_PASS');
