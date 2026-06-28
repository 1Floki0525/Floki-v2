'use strict';

const assert = require('node:assert/strict');
const {
  forceRemove
} = require('../src/self-improvement/training/hf-rem-inference.cjs');

const config = {
  sandbox_engine: 'podman',
  project_root: '/tmp',
  podman_command_timeout_ms: 1000,
  podman_output_buffer_bytes: 1024
};

const absent = forceRemove('already-gone', config, {
  spawnSync: () => ({
    status: 1,
    stdout: '',
    stderr: 'Error: no container with name or ID already-gone found'
  })
});
assert.equal(absent.ok, true);
assert.equal(absent.removed, false);
assert.equal(absent.reason, 'already_absent');

const removed = forceRemove('present', config, {
  spawnSync: () => ({ status: 0, stdout: 'present\n', stderr: '' })
});
assert.equal(removed.ok, true);
assert.equal(removed.removed, true);

assert.throws(
  () => forceRemove('denied', config, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'permission denied' })
  }),
  /FLOKI_HF_REM_CONTAINER_CLEANUP_FAILED: permission denied/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_HF_REM_CONTAINER_CLEANUP_PASS',
  auto_remove_absence_accepted: true,
  real_cleanup_failure_surfaced: true
}, null, 2));
