'use strict';

// Contract: the GPU ownership lock guarantees exactly one owner at a time among
// {ollama_cognition, hf_training, hf_rem_inference, vision}, with explicit
// acquire/transfer/release and persistence. Exercises real functions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gpu = require('../src/self-improvement/training/gpu-ownership.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-gpu-'));
const config = Object.assign({}, base, { gpu_ownership_lock_file: path.join(tmp, 'gpu-owner.lock') });

try {
  assert.equal(gpu.currentOwner(config), null, 'no owner initially');

  // acquire
  const owned = gpu.acquire('hf_training', { run_id: 'rsi-1' }, config);
  assert.equal(owned.owner, 'hf_training');
  assert.equal(gpu.currentOwner(config), 'hf_training');
  gpu.assertOwnedBy('hf_training', config);

  // exclusivity: a different owner cannot acquire
  assert.throws(() => gpu.acquire('vision', {}, config), /already owned by hf_training/);
  assert.throws(() => gpu.acquire('ollama_cognition', {}, config), /already owned by hf_training/);

  // re-acquire by same owner is idempotent
  gpu.acquire('hf_training', {}, config);
  assert.equal(gpu.currentOwner(config), 'hf_training');

  // unknown owner rejected
  assert.throws(() => gpu.acquire('gpu_miner', {}, config), /unknown GPU owner/);

  // transfer requires the stated current owner
  assert.throws(() => gpu.transfer('vision', 'hf_rem_inference', {}, config), /expected current owner vision/);
  const transferred = gpu.transfer('hf_training', 'hf_rem_inference', { reason: 'rem_cycle' }, config);
  assert.equal(transferred.owner, 'hf_rem_inference');
  assert.equal(gpu.currentOwner(config), 'hf_rem_inference');

  // transfer back to training, then release
  gpu.transfer('hf_rem_inference', 'hf_training', {}, config);
  // non-owner cannot release
  assert.throws(() => gpu.release('vision', config), /release by non-owner/);
  gpu.release('hf_training', config);
  assert.equal(gpu.currentOwner(config), null, 'released');

  // persistence: lock survives a fresh read (simulating process restart)
  gpu.acquire('ollama_cognition', {}, config);
  const reread = gpu.readOwner(config);
  assert.equal(reread.owner, 'ollama_cognition', 'ownership persisted to disk');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_GPU_OWNERSHIP_PASS',
  exclusivity_enforced: true,
  explicit_transfer: true,
  release_guarded: true,
  persisted: true
}, null, 2));
