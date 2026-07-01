'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNightlySession } = require('../src/self-improvement/training/nightly-training-session.cjs');
const { createNightlyTrainingCoordinator } = require('../src/self-improvement/training/training-scheduler.cjs');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-one-nightly-candidate-'));
  try {
    const config = {
      training_runtime_root: tmp,
      nightly_training_session_file_name: 'nightly-session.json',
      training_enabled: true,
      nightly_training_enabled: true
    };

    const existing = {
      marker: 'FLOKI_V2_NIGHTLY_TRAINING_SESSION',
      schema_version: 1,
      run_id: 'nightly-training-existing',
      sleep_date: '2026-07-01',
      finalized: true,
      active: false,
      resource_entered: false,
      candidate_id: 'candidate-existing',
      adapter_id: 'adapter-existing'
    };

    fs.writeFileSync(
      path.join(tmp, config.nightly_training_session_file_name),
      JSON.stringify(existing, null, 2) + '\n'
    );

    const reused = createNightlySession({
      config,
      sleep_window: {
        sleep_date: existing.sleep_date,
        start_at: '2026-07-01T23:00:00-04:00',
        end_at: '2026-07-02T07:00:00-04:00'
      }
    });

    assert.equal(reused.run_id, existing.run_id);
    assert.equal(reused.candidate_id, existing.candidate_id);

    let createCalls = 0;
    let enterCalls = 0;
    const coordinator = createNightlyTrainingCoordinator({
      config,
      get_sleep_window: () => ({
        sleep_date: existing.sleep_date,
        start_at: '2026-07-01T23:00:00-04:00',
        end_at: '2026-07-02T07:00:00-04:00'
      }),
      is_within_sleep_window: () => true,
      read_manual_nap: () => ({ active: false }),
      read_session: () => existing,
      create_session: () => {
        createCalls += 1;
        throw new Error('second nightly session must not be created');
      },
      enter_resource: async () => {
        enterCalls += 1;
        throw new Error('finalized nightly session must not re-enter resources');
      },
      status: () => {},
      audit: () => {}
    });

    const result = await coordinator.reconcile({
      now: new Date('2026-07-02T01:00:00-04:00')
    });

    assert.equal(result.action, 'nightly_training_already_finalized');
    assert.equal(result.session.run_id, existing.run_id);
    assert.equal(createCalls, 0);
    assert.equal(enterCalls, 0);
    console.log('FLOKI_ONE_NIGHTLY_TRAINING_CANDIDATE_PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
