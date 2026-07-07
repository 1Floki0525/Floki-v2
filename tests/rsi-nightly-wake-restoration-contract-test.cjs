'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createNightlyTrainingCoordinator
} = require('../src/self-improvement/training/training-scheduler.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-nightly-wake-'));
  const config = {
    training_enabled: true,
    nightly_training_enabled: true,
    nightly_rem_provider: 'huggingface',
    training_rem_claim_file: path.join(root, 'claims.json')
  };
  const calls = [];
  let session = {
    run_id: 'wake-test',
    sleep_date: '2026-06-27',
    active: true,
    finalized: false,
    resource_entered: true,
    current_container: 'training-container'
  };

  const coordinator = createNightlyTrainingCoordinator({
    config,
    gpu: {
      currentOwner: () => 'hf_training',
      readOwner: () => ({ owner: 'hf_training' }),
      release: () => {},
      transfer: () => {},
      acquire: () => {}
    },
    read_session: () => session,
    refresh_session: (value) => value,
    checkpoint_session: async (value) => {
      calls.push('checkpoint');
      session = { ...value, current_container: null };
      return { ok: true, session };
    },
    finalize_session: (value) => {
      calls.push('finalize-candidate');
      session = { ...value, active: false, finalized: true };
      return session;
    },
    enter_resource: async () => ({ ok: true }),
    exit_resource: async () => {
      calls.push('restore-runtime');
      return { ok: true, result: { lifecycle_restored: true } };
    },
    set_resource_entered: (value, entered) => {
      session = { ...value, resource_entered: entered };
      return session;
    },
    write_session: (value) => {
      session = value;
      return value;
    },
    get_sleep_window: () => ({
      sleep_date: '2026-06-27',
      start_at: '2026-06-28T03:00:00.000Z',
      end_at: '2026-06-28T11:00:00.000Z'
    }),
    is_within_sleep_window: () => false,
    read_manual_nap: () => null,
    audit: () => {},
    status: () => {}
  });

  const result = await coordinator.reconcile({
    now: new Date('2026-06-28T11:00:01.000Z')
  });

  assert.equal(result.action, 'wake_restoration');
  assert.deepEqual(calls, [
    'checkpoint',
    'finalize-candidate',
    'restore-runtime'
  ]);
  assert.equal(session.finalized, true);
  assert.equal(session.resource_entered, false);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_NIGHTLY_WAKE_RESTORATION_PASS',
    checkpointed_before_wake: true,
    candidate_finalized_before_restore: true,
    runtime_restored: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
