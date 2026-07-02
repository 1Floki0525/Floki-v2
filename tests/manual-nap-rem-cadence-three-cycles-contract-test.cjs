'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  beginManualNap,
  wakeManualNap,
  claimDueRemCycle,
  finishRemCycle
} = require('../src/chat/manual-nap.cjs');
const { getSleepConfig } = require('../src/config/floki-config.cjs');

const sleepConfig = getSleepConfig('chat');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-nap-rem-cadence-'));
const stateFile = path.join(dir, 'state.json');
const start = new Date('2026-06-22T15:00:00.000Z');

async function main() {
  assert.equal(sleepConfig.manual_nap_duration_minutes, 30);
  assert.equal(sleepConfig.manual_nap_rem_offset_minutes, 10);
  assert.equal(sleepConfig.manual_nap_max_rem_cycles, 2);

  const nap = beginManualNap({ state_file: stateFile, now: start });
  assert.equal(nap.rem_cycles.length, 2, '30-minute nap must have REM only at +10 and +20');
  const offsets = nap.rem_cycles.map((cycle) => new Date(cycle.scheduled_at).getTime() - start.getTime());
  assert.deepEqual(offsets, [10 * 60000, 20 * 60000]);
  assert.equal(new Date(nap.wake_at).getTime() - start.getTime(), 30 * 60000);
  assert.equal(claimDueRemCycle({ state_file: stateFile, now: start }), null, 'no REM is due at nap start');

  for (const expectedMinute of [10, 20]) {
    const cycle = claimDueRemCycle({ state_file: stateFile, now: new Date(start.getTime() + expectedMinute * 60000) });
    assert.ok(cycle, 'claim must succeed at +' + expectedMinute + ' minutes');
    finishRemCycle({ dream_txt_file: '/tmp/dream-' + expectedMinute + '.txt' }, null, {
      state_file: stateFile,
      now: new Date(start.getTime() + expectedMinute * 60000 + 1000)
    });
  }

  const final = wakeManualNap('test_wake', { state_file: stateFile, now: new Date(start.getTime() + 30 * 60000) });
  assert.equal(final.active, false);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_MANUAL_NAP_REM_CADENCE_PASS',
    rem_cycles: 2,
    rem_offsets_minutes: [10, 20],
    wake_at_minute: 30,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_MANUAL_NAP_REM_CADENCE_FAIL', error: error.message }, null, 2));
  process.exit(1);
});
