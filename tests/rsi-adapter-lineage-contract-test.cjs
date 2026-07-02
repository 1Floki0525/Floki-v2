'use strict';

// Contract: adapter lineage records preserve full lineage (parent identity,
// dataset hash, config hash, seed, version, approval/activation status, rollback
// target), version monotonically, and retain rollback targets. Real functions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lineage = require('../src/self-improvement/training/lineage.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-lin-'));
const config = Object.assign({}, base, { adapter_root: path.join(tmp, 'adapters'), rollback_retention_count: 2 });

try {
  // --- first adapter: no prior approved => rollback target is hf_master ---
  const v1 = lineage.createLineageRecord({
    parent_checkpoint_path: '/host/Qwen3.5-4B',
    dataset_id: 'ds-1',
    dataset_hash: 'abc123',
    training_config: { method: 'qlora', lora: { r: 16 } },
    seed: 42,
    metrics: { loss: 1.2 }
  }, config);
  for (const f of lineage.REQUIRED_LINEAGE_FIELDS) {
    assert.ok(v1[f] !== undefined, 'lineage has field ' + f);
  }
  assert.equal(v1.candidate_type, 'model_adapter');
  assert.equal(v1.version, 'v1');
  assert.equal(v1.approval_status, 'pending');
  assert.equal(v1.activation_status, 'inactive');
  assert.equal(v1.rollback_target, 'hf_master', 'first adapter rolls back to hf_master');
  assert.equal(typeof v1.training_config_hash, 'string');
  lineage.persistLineage(v1, config);

  // approve + activate v1 (simulate a promoted adapter on disk)
  const v1Approved = Object.assign({}, v1, { approval_status: 'approved', activation_status: 'active' });
  lineage.persistLineage(v1Approved, config);

  // --- second adapter: version bumps; rollback target becomes prior approved ---
  const v2 = lineage.createLineageRecord({
    parent_checkpoint_path: '/host/Qwen3.5-4B',
    dataset_id: 'ds-2',
    dataset_hash: 'def456',
    training_config: { method: 'qlora', lora: { r: 16 } },
    seed: 42
  }, config);
  assert.equal(v2.version, 'v2', 'version monotonically increases');
  assert.equal(v2.version_number, 2);
  assert.equal(v2.rollback_target, v1Approved.adapter_id, 'rollback target is the prior approved adapter');
  assert.equal(v2.lineage_parent_adapter, v1Approved.adapter_id);
  lineage.persistLineage(v2, config);

  // --- listing + rollback retention ---
  const all = lineage.listAdapters(config);
  assert.ok(all.length >= 2, 'adapters listed');
  const targets = lineage.rollbackTargets(config);
  assert.ok(targets.length <= config.rollback_retention_count, 'rollback retention bounded');

  // --- missing required input throws ---
  assert.throws(() => lineage.createLineageRecord({ parent_checkpoint_path: '/x' }, config), /missing required input/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_ADAPTER_LINEAGE_PASS',
  full_lineage_fields: lineage.REQUIRED_LINEAGE_FIELDS.length,
  version_monotonic: true,
  rollback_target_preserved: true,
  retention_bounded: true
}, null, 2));
