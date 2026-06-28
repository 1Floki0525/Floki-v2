'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  forceRemoveContainer,
  waitForDetachedContainerLaunch
} = require('../src/self-improvement/training/nightly-training-session.cjs');

const config = {
  sandbox_engine: 'podman',
  project_root: '/tmp',
  podman_command_timeout_ms: 1000,
  podman_output_buffer_bytes: 1024
};

const absent = forceRemoveContainer('already-gone', config, {
  spawnSync: () => ({
    status: 1,
    stdout: '',
    stderr: 'object does not exist'
  })
});
assert.equal(absent.ok, true);
assert.equal(absent.removed, false);

assert.throws(
  () => forceRemoveContainer('denied', config, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'permission denied' })
  }),
  /FLOKI_NIGHTLY_TRAINING_CONTAINER_CLEANUP_FAILED: permission denied/
);

(async () => {
  const child = new EventEmitter();
  const launch = waitForDetachedContainerLaunch(
    child,
    'fixture',
    config,
    { waitForContainerStart: () => Promise.reject(new Error('not visible')) }
  );
  await assert.rejects(launch, /not visible/);
  assert.equal(child.listenerCount('error'), 0);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_NIGHTLY_TRAINING_LAUNCH_CLEANUP_PASS',
    launch_failure_surfaced: true,
    cleanup_absence_accepted: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
