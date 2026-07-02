'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createNightlyTrainingCoordinator,
  readRemClaims
} = require('../src/self-improvement/training/training-scheduler.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-training-failure-rem-'));
  const dreamTxt = path.join(root, 'dream.txt');
  fs.writeFileSync(dreamTxt, 'dream');

  const config = {
    training_enabled: true,
    nightly_training_enabled: true,
    nightly_training_provider: 'huggingface',
    nightly_rem_provider: 'huggingface',
    hf_rem_system_prompt: 'configured prompt',
    training_rem_claim_file: path.join(root, 'claims.json')
  };
  const calls = [];
  let owner = 'hf_training';
  let session = {
    run_id: 'nightly-failure-test',
    sleep_date: '2026-06-27',
    active: true,
    finalized: false,
    resource_entered: true,
    training_failed: false,
    current_container: 'failed-training-container'
  };

  const coordinator = createNightlyTrainingCoordinator({
    config,
    gpu: {
      currentOwner: () => owner,
      readOwner: () => ({ owner }),
      transfer(from, to) {
        calls.push('gpu:' + from + '->' + to);
        assert.equal(owner, from);
        owner = to;
        return { owner };
      },
      acquire(to) { owner = to; return { owner }; },
      release(from) {
        calls.push('gpu:release:' + from);
        assert.equal(owner, from);
        owner = null;
      }
    },
    read_session: () => session,
    refresh_session: (value) => value,
    checkpoint_session: async () => {
      calls.push('checkpoint-failed');
      throw new Error('fixture checkpoint failure');
    },
    force_container: (name) => {
      calls.push('force-remove:' + name);
      return { ok: true, removed: true };
    },
    write_session: (value) => {
      session = value;
      return value;
    },
    mark_training_error: (value, error) => {
      calls.push('training-error:' + error.message);
      session = { ...value, training_failed: true, training_error: error.message };
      return session;
    },
    get_sleep_window: () => ({
      sleep_date: '2026-06-27',
      start_at: '2026-06-28T03:00:00.000Z',
      end_at: '2026-06-28T11:00:00.000Z'
    }),
    is_within_sleep_window: () => true,
    read_manual_nap: () => null,
    run_hf_generation: async () => {
      calls.push('hf-rem-generation');
      return { model: 'approved-lineage', response_json: { ok: true } };
    },
    run_dream_engine: async (options) => {
      await options.dream_generator({ prompt: 'p', context: {}, schema: {} });
      return { ok: true, dream_txt_file: dreamTxt, dream_metadata_file: null };
    },
    audit: () => {},
    status: () => {}
  });

  const result = await coordinator.runNightlyRem({
    now: new Date('2026-06-28T04:10:00.000Z'),
    rem_cycle_number: 8
  });

  assert.equal(result.ok, true);
  assert.match(result.checkpoint_error, /fixture checkpoint failure/);
  assert.equal(session.training_failed, true);
  assert.equal(owner, null, 'failed training must not resume after successful REM');
  assert.deepEqual(calls, [
    'checkpoint-failed',
    'force-remove:failed-training-container',
    'training-error:fixture checkpoint failure',
    'gpu:hf_training->hf_rem_inference',
    'hf-rem-generation',
    'gpu:release:hf_rem_inference'
  ]);
  assert.equal(
    readRemClaims(config).claims['2026-06-27:cycle-8'].status,
    'complete'
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_TRAINING_FAILURE_REM_CONTINUITY_PASS',
    training_failure_did_not_skip_rem: true,
    failed_training_not_resumed: true,
    rem_claim_completed: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
