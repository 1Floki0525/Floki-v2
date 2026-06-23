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
const stateFile = path.join(dir, 'state.json');
const start = new Date('2026-06-22T15:00:00.000Z');
const yaml = loadYamlFile(path.join(__dirname, '../config/chat.config.yaml'));

assert.equal(yaml.sleep.start_hhmm, '23:00');
assert.equal(yaml.sleep.end_hhmm, '07:00');
assert.equal(yaml.sleep.manual_nap_duration_minutes, 30);
assert.equal(yaml.sleep.rem_interval_minutes, 10);
assert.equal(yaml.sleep.manual_nap_rem_offset_minutes, 10);

const legacyState = {
  kind: 'manual_nap',
  active: true,
  completed: false,
  duration_minutes: 30,
  started_at: start.toISOString(),
  wake_at: new Date(start.getTime() + 30 * 60000).toISOString(),
  last_transition_at: start.toISOString(),
  wake_reason: null,
  rem_cycles: [{
    cycle_number: 1,
    scheduled_at: new Date(start.getTime() + 15 * 60000).toISOString(),
    status: 'pending'
  }],
  nightly_schedule_modified: false,
  chat_mode_only: true,
  game_mode_started: false
};
fs.writeFileSync(stateFile, JSON.stringify(legacyState, null, 2) + '\n');

const migrated = readManualNapState({
  state_file: stateFile,
  now: new Date(start.getTime() + 9 * 60000)
});
assert.equal(migrated.rem_interval_minutes, 10);
assert.equal(migrated.rem_cycles.length, 2);
assert.equal(
  new Date(migrated.rem_cycles[0].scheduled_at).getTime() - start.getTime(),
  10 * 60000
);
assert.equal(
  new Date(migrated.rem_cycles[1].scheduled_at).getTime() - start.getTime(),
  20 * 60000
);
assert.equal(
  claimDueRemCycle({
    state_file: stateFile,
    now: new Date(start.getTime() + 9 * 60000)
  }),
  null
);

const firstClaim = claimDueRemCycle({
  state_file: stateFile,
  now: new Date(start.getTime() + 10 * 60000)
});
assert.equal(firstClaim.cycle.cycle_number, 1);
assert.equal(firstClaim.cycle.status, 'dreaming');

finishRemCycle(
  { dream_txt_file: '/tmp/dream-1.txt' },
  null,
  {
    state_file: stateFile,
    now: new Date(start.getTime() + 11 * 60000)
  }
);

const secondClaim = claimDueRemCycle({
  state_file: stateFile,
  now: new Date(start.getTime() + 20 * 60000)
});
assert.equal(secondClaim.cycle.cycle_number, 2);
assert.equal(secondClaim.cycle.status, 'dreaming');

finishRemCycle(
  { dream_txt_file: '/tmp/dream-2.txt' },
  null,
  {
    state_file: stateFile,
    now: new Date(start.getTime() + 21 * 60000)
  }
);

const completed = readManualNapState({
  state_file: stateFile,
  now: new Date(start.getTime() + 21 * 60000)
});
assert.equal(completed.rem_cycles[0].status, 'complete');
assert.equal(completed.rem_cycles[1].status, 'complete');
assert.equal(completed.nightly_schedule_modified, false);

assert.equal(
  wakeManualNap('manual_wake', {
    state_file: stateFile,
    now: new Date(start.getTime() + 25 * 60000)
  }).active,
  false
);

const freshStateFile = path.join(dir, 'fresh-state.json');
const fresh = beginManualNap({
  state_file: freshStateFile,
  now: start,
  consolidation: { ok: true }
});
assert.equal(fresh.duration_minutes, 30);
assert.equal(fresh.rem_interval_minutes, 10);
assert.equal(fresh.rem_cycles.length, 2);
assert.equal(
  new Date(fresh.wake_at).getTime() - start.getTime(),
  30 * 60000
);
assert.equal(fresh.nightly_schedule_modified, false);

fs.rmSync(dir, { recursive: true, force: true });
console.log('FLOKI_V22_MANUAL_NAP_TEN_MINUTE_REM_CONTRACT_PASS');
