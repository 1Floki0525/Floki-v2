'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.FLOKI_CONFIG_PATH = path.join(__dirname, 'fixtures', 'chat.config.test.yaml');

const { beginManualNap, claimDueRemCycle, finishRemCycle } = require('../src/chat/manual-nap.cjs');

const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'floki-nap-retry-')), 'nap.json');
const started = new Date('2026-06-23T12:00:00.000Z');

beginManualNap({ state_file: stateFile, now: started });

const claim = claimDueRemCycle({ state_file: stateFile, now: new Date(started.getTime() + 10 * 60000) });
assert.equal(claim.cycle.cycle_number, 1);
assert.equal(claim.cycle.stage, 'generating');

const regenResult = {
  ok: false,
  regeneration_needed: true,
  stage: 'regenerating',
  marker: 'FLOKI_V2_DREAM_ENGINE_REGENERATION_NEEDED',
  last_error: 'novelty violations: same opening as a recent dream'
};

const afterReject = finishRemCycle(regenResult, null, { state_file: stateFile, now: new Date(started.getTime() + 10 * 60000 + 1000) });
assert.equal(afterReject.rem_cycles[0].status, 'pending');
assert.equal(afterReject.rem_cycles[0].stage, 'regenerating');
assert.equal(afterReject.rem_cycles[0].quality_retry_count, 1);
assert.equal(afterReject.rem_cycles[0].dream_txt_file, null);
assert.ok(afterReject.rem_cycles[0].next_retry_at, 'regenerating cycle must have a next_retry_at');
assert.equal(afterReject.last_rem_error, null);
assert.equal(afterReject.last_quality_retry, regenResult.last_error);

const beforeBackoff = claimDueRemCycle({ state_file: stateFile, now: new Date(started.getTime() + 10 * 60000 + 2000) });
assert.equal(beforeBackoff, null, 'cycle must not be claimed before backoff expires');

const afterBackoff = claimDueRemCycle({ state_file: stateFile, now: new Date(afterReject.rem_cycles[0].next_retry_at) });
assert.ok(afterBackoff, 'cycle must be reclaimable after backoff');
assert.equal(afterBackoff.cycle.cycle_number, 1);
assert.equal(afterBackoff.cycle.stage, 'generating');

const success = finishRemCycle({ dream_txt_file: '/tmp/dream-1.txt', dream_metadata_file: '/tmp/dream-1.json' }, null, { state_file: stateFile, now: new Date(started.getTime() + 11 * 60000) });
assert.equal(success.rem_cycles[0].status, 'complete');
assert.equal(success.rem_cycles[0].stage, 'complete');
assert.equal(success.rem_cycles[0].dream_txt_file, '/tmp/dream-1.txt');

const claim2 = claimDueRemCycle({ state_file: stateFile, now: new Date(started.getTime() + 20 * 60000) });
assert.equal(claim2.cycle.cycle_number, 2);
assert.equal(claim2.cycle.stage, 'generating');

const legacyError = finishRemCycle(null, new Error('DREAM_QUALITY_CONTRACT_REJECTED_AFTER_5_ATTEMPTS: dream quality violations: duplicate opening'), { state_file: stateFile, now: new Date(started.getTime() + 20 * 60000 + 1000) });
assert.equal(legacyError.rem_cycles[1].status, 'pending');
assert.equal(legacyError.rem_cycles[1].stage, 'regenerating');
assert.equal(legacyError.rem_cycles[1].quality_retry_count, 1);
assert.ok(legacyError.rem_cycles[1].next_retry_at);

fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
console.log('FLOKI_V22_MANUAL_NAP_REM_RETRY_CONTRACT_PASS');
