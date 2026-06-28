'use strict';

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

function readLineageManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('lineage manifest root must be an object');
    }
    return value;
  } catch (error) {
    throw new Error(
      'FLOKI_ADAPTER_LINEAGE_READ_FAILED: ' + file + ': ' +
      (error && error.message ? error.message : String(error))
    );
  }
}

function listAdapters(config = loadSelfImprovementConfig()) {
  const root = adapterRoot(config);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const manifest = path.join(root, name, config.adapter_manifest_file_name);
    if (fs.existsSync(manifest)) {
      out.push(readLineageManifest(manifest));
    }
  }
  return out.sort(
    (left, right) =>
      Number(left.version_number || 0) - Number(right.version_number || 0)
  );
}

function nextAdapterVersion(config = loadSelfImprovementConfig()) {
  const adapters = listAdapters(config);
  const max = adapters.reduce(
    (current, adapter) =>
      Math.max(current, Number(adapter.version_number || 0)),
    0
  );
  const versionNumber = max + 1;
  return {
    version_number: versionNumber,
    version: config.adapter_version_prefix + versionNumber
  };
}

function hashObject(value, algorithm) {
  return crypto
    .createHash(algorithm || 'sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function createLineageRecord(input, config = loadSelfImprovementConfig()) {
  if (!input || typeof input !== 'object') {
    throw new Error('lineage input must be an object');
  }
  const required = [
    'parent_checkpoint_path',
    'dataset_hash',
    'training_config',
    'seed'
  ];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      throw new Error('lineage missing required input: ' + field);
    }
  }
  const version = input.version || nextAdapterVersion(config);
  const adapterId =
    config.adapter_id_prefix + '-' + version.version + '-' +
    crypto.randomBytes(3).toString('hex');

  const adapters = listAdapters(config);
  const priorApproved = adapters.filter(
    (adapter) =>
      adapter.approval_status === 'approved' ||
      adapter.activation_status === 'active'
  );
  const rollbackTarget = input.rollback_target || (
    priorApproved.length > 0
      ? priorApproved[priorApproved.length - 1].adapter_id
      : 'hf_master'
  );

  const record = {
    marker: 'FLOKI_V2_RSI_ADAPTER_LINEAGE',
    schema_version: 1,
    adapter_id: adapterId,
    candidate_type: 'model_adapter',
    version: version.version,
    version_number: version.version_number,
    created_at: new Date().toISOString(),
    parent_checkpoint_path: input.parent_checkpoint_path,
    parent_checkpoint_identity:
      input.parent_checkpoint_identity ||
      path.basename(String(input.parent_checkpoint_path)),
    dataset_id: input.dataset_id || null,
    dataset_hash: input.dataset_hash,
    training_config_hash: hashObject(
      input.training_config,
      config.dataset_hash_algorithm
    ),
    seed: input.seed,
    metrics: input.metrics || null,
    evaluation_results: input.evaluation_results || null,
    lineage_parent_adapter:
      priorApproved.length > 0
        ? priorApproved[priorApproved.length - 1].adapter_id
        : null,
    approval_status: 'pending',
    activation_status: 'inactive',
    rollback_target: rollbackTarget
  };

  for (const field of REQUIRED_LINEAGE_FIELDS) {
    if (record[field] === undefined) {
      throw new Error('lineage record missing field: ' + field);
    }
  }
  return Object.freeze(record);
}

function persistLineage(record, config = loadSelfImprovementConfig()) {
  const dir = path.join(adapterRoot(config), record.adapter_id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, config.adapter_manifest_file_name);
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
  return file;
}

function rollbackTargets(config = loadSelfImprovementConfig()) {
  const approved = listAdapters(config).filter(
    (adapter) =>
      adapter.approval_status === 'approved' ||
      adapter.activation_status === 'active'
  );
  return approved.slice(-config.rollback_retention_count).reverse();
}

module.exports = {
  REQUIRED_LINEAGE_FIELDS,
  adapterRoot,
  createLineageRecord,
  hashObject,
  listAdapters,
  nextAdapterVersion,
  persistLineage,
  readLineageManifest,
  rollbackTargets
};
