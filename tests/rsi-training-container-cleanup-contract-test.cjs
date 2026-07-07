'use strict';

const assert = require('node:assert/strict');
const {
  removeTrainingContainer,
  waitForTrainingContainerLaunch
} = require('../src/self-improvement/training/training-runner.cjs');
const {
  EventEmitter
} = require('node:events');

const config = {
  sandbox_engine: 'podman',
  project_root: '/tmp',
  podman_command_timeout_ms: 1000,
  podman_output_buffer_bytes: 1024
};

const absent = removeTrainingContainer('already-gone', config, {
  spawnSync: () => ({
    status: 1,
    stdout: '',
    stderr: 'no such container: already-gone'
  })
});
assert.equal(absent.ok, true);
assert.equal(absent.removed, false);

const removed = removeTrainingContainer('present', config, {
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' })
});
assert.equal(removed.removed, true);

assert.throws(
  () => removeTrainingContainer('denied', config, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'permission denied' })
  }),
  /FLOKI_TRAINING_CONTAINER_CLEANUP_FAILED: permission denied/
);

(async () => {
  const child = new EventEmitter();
  const launch = waitForTrainingContainerLaunch(
    child,
    'fixture',
    config,
    { waitForContainerStart: () => new Promise(() => {}) }
  );
  child.emit('error', new Error('spawn failed'));
  await assert.rejects(launch, /spawn failed/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_TRAINING_CONTAINER_CLEANUP_PASS',
    auto_remove_absence_accepted: true,
    spawn_error_surfaced: true,
    real_cleanup_failure_surfaced: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
