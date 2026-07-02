'use strict';

const assert = require('node:assert/strict');

const {
  createNightlyTrainingCoordinator
} = require(
  '../src/self-improvement/training/training-scheduler.cjs'
);

(async () => {
  const session = {
    run_id: 'nightly-run-one',
    sleep_date: '2026-07-01',
    finalized: false,
    resource_entered: true,
    current_container: null,
    training_failed: false
  };

  let interrupted = true;
  let owner = 'hf_rem_inference';
  let starts = 0;
  let transfers = 0;

  const config = {
    training_enabled: true,
    nightly_training_enabled: true
  };

  const coordinator =
    createNightlyTrainingCoordinator({
      config,
      load_config: () => config,
      get_sleep_window: () => ({
        sleep_date: session.sleep_date,
        start_at:
          '2026-07-01T23:00:00-04:00',
        end_at:
          '2026-07-02T07:00:00-04:00'
      }),
      is_within_sleep_window: () => true,
      read_manual_nap: () => ({
        active: false
      }),
      read_session: () => session,
      refresh_session: (value) => value,
      read_sleep_state: () => ({
        interrupted,
        rem_cycles: []
      }),
      set_resource_entered: (value) => value,
      start_segment: async (value) => {
        starts += 1;
        assert.equal(
          value.run_id,
          session.run_id
        );
        return {
          ...value,
          current_container:
            'same-session-next-segment'
        };
      },
      gpu: {
        currentOwner: () => owner,
        readOwner: () => ({
          owner
        }),
        transfer(from, to) {
          assert.equal(from, 'hf_rem_inference');
          assert.equal(to, 'hf_training');
          transfers += 1;
          owner = to;
          return {
            owner
          };
        },
        acquire(next) {
          owner = next;
          return {
            owner
          };
        },
        release() {
          owner = null;
          return true;
        }
      },
      status: () => {},
      audit: () => {}
    });

  const duringConversation =
    await coordinator.reconcile({
      now: new Date(
        '2026-07-02T00:15:00-04:00'
      )
    });

  assert.equal(
    duringConversation.action,
    'nightly_chat_interruption'
  );
  assert.equal(starts, 0);
  assert.equal(owner, 'hf_rem_inference');

  interrupted = false;

  const afterIdle = await coordinator.reconcile({
    now: new Date(
      '2026-07-02T00:20:00-04:00'
    )
  });

  assert.equal(
    afterIdle.action,
    'nightly_training'
  );
  assert.equal(
    afterIdle.session.run_id,
    session.run_id
  );
  assert.equal(
    afterIdle.session.current_container,
    'same-session-next-segment'
  );
  assert.equal(transfers, 1);
  assert.equal(starts, 1);
  assert.equal(owner, 'hf_training');

  console.log(
    'FLOKI_NIGHT_CHAT_TRAINING_IDLE_RESUME_PASS'
  );
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
