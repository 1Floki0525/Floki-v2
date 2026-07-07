'use strict';

// Contract: HF master preflight verifies the immutable safetensors checkpoint is
// present and complete before training, and fails closed (placeholder/missing).
// Read-only; never modifies the master. Real functions, boundary-double dir.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pre = require('../src/self-improvement/training/master-preflight.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();

// --- placeholder path fails closed ---
const placeholder = pre.preflightHfMaster(Object.assign({}, base, { hf_master_path: '/absolute/path/to/Qwen3.5-4B' }));
assert.equal(placeholder.ok, false);
assert.equal(placeholder.is_placeholder, true);
assert.throws(() => pre.assertHfMasterReady(Object.assign({}, base, { hf_master_path: '/absolute/path/to/Qwen3.5-4B' })), /placeholder/);

// --- missing directory fails closed ---
const missing = pre.preflightHfMaster(Object.assign({}, base, { hf_master_path: '/nonexistent/floki/master' }));
assert.equal(missing.ok, false);
assert.equal(missing.exists, false);

// --- complete boundary-double master passes ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-master-'));
try {
  for (const f of base.hf_master_required_files.split('|')) {
    fs.writeFileSync(path.join(tmp, f), '{}');
  }
  fs.writeFileSync(path.join(tmp, 'model.safetensors-00001-of-00002.safetensors'), 'x');
  const okCfg = Object.assign({}, base, { hf_master_path: tmp });
  const good = pre.preflightHfMaster(okCfg);
  assert.equal(good.ok, true, 'complete master passes: ' + JSON.stringify(good.missing));
  assert.equal(good.has_safetensors, true);
  assert.equal(good.missing.length, 0);
  pre.assertHfMasterReady(okCfg);

  // --- incomplete master (missing a required file) fails closed ---
  fs.rmSync(path.join(tmp, 'tokenizer.json'));
  const incomplete = pre.preflightHfMaster(okCfg);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.missing.includes('tokenizer.json'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_HF_MASTER_PREFLIGHT_PASS',
  placeholder_fails_closed: true,
  missing_fails_closed: true,
  complete_passes: true,
  incomplete_fails_closed: true
}, null, 2));
