'use strict';

// Adapter lineage and versioning for the RSI training pipeline.
//
// Each training run produces a versioned candidate adapter whose lineage record
// preserves parent checkpoint identity, dataset hash, training config hash, seed,
// adapter version, metrics, evaluation results, approval status, activation
// status, and rollback target. The previous approved model is never overwritten;
// rollback targets are retained per YAML. All paths/limits from chat YAML.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadSelfImprovementConfig } = require('../config.cjs');

const REQUIRED_LINEAGE_FIELDS = Object.freeze([
  'parent_checkpoint_path',
  'parent_checkpoint_identity',
  'dataset_hash',
  'training_config_hash',
  'seed',
  'version',
  'candidate_type',
  'approval_status',
  'activation_status',
  'rollback_target'
]);

function adapterRoot(config) {
  return config.adapter_root;
}

function listAdapters(config = loadSelfImprovementConfig()) {
  const root = adapterRoot(config);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const manifest = path.join(root, name, config.adapter_manifest_file_name);
    if (fs.existsSync(manifest)) {
      try { out.push(JSON.parse(fs.readFileSync(manifest, 'utf8'))); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => (a.version_number || 0) - (b.version_number || 0));
}

function nextAdapterVersion(config = loadSelfImprovementConfig()) {
  const adapters = listAdapters(config);
  const max = adapters.reduce((m, a) => Math.max(m, a.version_number || 0), 0);
  const n = max + 1;
  return { version_number: n, version: config.adapter_version_prefix + n };
}

function hashObject(obj, algorithm) {
  return crypto.createHash(algorithm || 'sha256').update(JSON.stringify(obj)).digest('hex');
}

function createLineageRecord(input, config = loadSelfImprovementConfig()) {
  if (!input || typeof input !== 'object') throw new Error('lineage input must be an object');
  const required = ['parent_checkpoint_path', 'dataset_hash', 'training_config', 'seed'];
  for (const f of required) {
    if (input[f] === undefined || input[f] === null) throw new Error('lineage missing required input: ' + f);
  }
  const version = input.version || nextAdapterVersion(config);
  const adapterId = config.adapter_id_prefix + '-' + version.version + '-' + crypto.randomBytes(3).toString('hex');

  // Prior approved adapter becomes the rollback target by default.
  const adapters = listAdapters(config);
  const priorApproved = adapters.filter((a) => a.approval_status === 'approved' || a.activation_status === 'active');
  const rollbackTarget = input.rollback_target || (priorApproved.length > 0
    ? priorApproved[priorApproved.length - 1].adapter_id
    : 'hf_master');

  const record = {
    marker: 'FLOKI_V2_RSI_ADAPTER_LINEAGE',
    schema_version: 1,
    adapter_id: adapterId,
    candidate_type: 'model_adapter',
    version: version.version,
    version_number: version.version_number,
    created_at: new Date().toISOString(),
    parent_checkpoint_path: input.parent_checkpoint_path,
    parent_checkpoint_identity: input.parent_checkpoint_identity || path.basename(String(input.parent_checkpoint_path)),
    dataset_id: input.dataset_id || null,
    dataset_hash: input.dataset_hash,
    training_config_hash: hashObject(input.training_config, config.dataset_hash_algorithm),
    seed: input.seed,
    metrics: input.metrics || null,
    evaluation_results: input.evaluation_results || null,
    lineage_parent_adapter: priorApproved.length > 0 ? priorApproved[priorApproved.length - 1].adapter_id : null,
    approval_status: 'pending',
    activation_status: 'inactive',
    rollback_target: rollbackTarget
  };

  for (const f of REQUIRED_LINEAGE_FIELDS) {
    if (record[f] === undefined) throw new Error('lineage record missing field: ' + f);
  }
  return Object.freeze(record);
}

function persistLineage(record, config = loadSelfImprovementConfig()) {
  const dir = path.join(adapterRoot(config), record.adapter_id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, config.adapter_manifest_file_name);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

// Rollback targets retained (most recent approved/active first), bounded by YAML.
function rollbackTargets(config = loadSelfImprovementConfig()) {
  const approved = listAdapters(config).filter((a) => a.approval_status === 'approved' || a.activation_status === 'active');
  return approved.slice(-config.rollback_retention_count).reverse();
}

module.exports = {
  REQUIRED_LINEAGE_FIELDS,
  listAdapters,
  nextAdapterVersion,
  createLineageRecord,
  persistLineage,
  rollbackTargets,
  hashObject,
  adapterRoot
};
