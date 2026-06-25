'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  readManualNapState,
  beginManualNap,
  wakeManualNap,
  claimDueRemCycle
} = require('../src/chat/manual-nap.cjs');
const { getSleepConfig } = require('../src/config/floki-config.cjs');

const sleepConfig = getSleepConfig('chat');
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'floki-nap-rem-cadence-'));
const stateFile = path.join(dir, 'state.json');
const start = new Date('2026-06-22T15:00:00.000Z');

async function main() {
  assert.equal(sleepConfig.manual_nap_rem_offset_minutes, 0, 'manual nap REM offset must be 0 minutes');
  const nap = beginManualNap({ state_file: stateFile, now: start });
  assert.equal(nap.rem_cycles.length, 3, 'manual nap must have exactly 3 REM cycles (one every 10 min)');
  const offsets = nap.rem_cycles.map((cycle) => new Date(cycle.scheduled_at).getTime() - start.getTime());
  assert.deepEqual(offsets, [0, 10 * 60000, 20 * 60000], 'manual nap REM must occur at +0, +10, +20 minutes');
  assert.equal(new Date(nap.wake_at).getTime() - start.getTime(), 30 * 60000, 'manual nap wake at +30 minutes');

  for (const expectedMinute of [0, 10, 20]) {
    const cycle = claimDueRemCycle({ state_file: stateFile, now: new Date(start.getTime() + expectedMinute * 60000) });
    assert.ok(cycle, 'claim must succeed at +' + expectedMinute + ' minutes');
    assert.equal(cycle.cycle.scheduled_at, new Date(start.getTime() + expectedMinute * 60000).toISOString());
    require('../src/chat/manual-nap.cjs').finishRemCycle({ dream_txt_file: '/tmp/dream-' + expectedMinute + '.txt' }, null, {
      state_file: stateFile,
      now: new Date(start.getTime() + expectedMinute * 60000 + 1000)
    });
  }
  const noClaim = claimDueRemCycle({ state_file: stateFile, now: new Date(start.getTime() - 1000) });
  assert.equal(noClaim, null, 'no claim before nap start');

  const final = wakeManualNap('test_wake', { state_file: stateFile, now: new Date(start.getTime() + 30 * 60000) });
  assert.equal(final.active, false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_MANUAL_NAP_REM_CADENCE_PASS',
    rem_cycles: nap.rem_cycles.length,
    rem_offsets_minutes: offsets.map((value) => value / 60000),
    wake_at_minute: 30,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_MANUAL_NAP_REM_CADENCE_FAIL', error: error.message }, null, 2));
  process.exit(1);
});
