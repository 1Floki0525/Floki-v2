'use strict';

// Hugging Face master checkpoint preflight.
//
// The local HF safetensors checkpoint is the immutable trainable master lineage.
// Training must not start until the master is verified present and complete.
// This module only READS; it never modifies the master. All paths from chat YAML.

const fs = require('node:fs');
const path = require('node:path');

const { loadSelfImprovementConfig } = require('../config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function preflightHfMaster(config = loadSelfImprovementConfig()) {
  const masterPath = config.hf_master_path;
  const required = splitPipeList(config.hf_master_required_files);
  const result = {
    marker: 'FLOKI_V2_HF_MASTER_PREFLIGHT',
    path: masterPath,
    exists: false,
    is_placeholder: typeof masterPath === 'string' && masterPath.includes('/absolute/path/'),
    present: [],
    missing: [],
    has_safetensors: false,
    ok: false
  };

  if (result.is_placeholder) {
    result.missing = required.slice();
    return Object.freeze(result);
  }
  if (!masterPath || !fs.existsSync(masterPath) || !fs.statSync(masterPath).isDirectory()) {
    result.missing = required.slice();
    return Object.freeze(result);
  }
  result.exists = true;

  for (const file of required) {
    if (fs.existsSync(path.join(masterPath, file))) result.present.push(file);
    else result.missing.push(file);
  }

  // At least one safetensors shard must be present.
  try {
    result.has_safetensors = fs.readdirSync(masterPath).some((n) => n.endsWith('.safetensors'));
  } catch {
    result.has_safetensors = false;
  }

  result.ok = result.missing.length === 0 && result.has_safetensors;
  return Object.freeze(result);
}

function assertHfMasterReady(config = loadSelfImprovementConfig()) {
  const pre = preflightHfMaster(config);
  if (!pre.ok) {
    throw new Error(
      'HF master checkpoint preflight failed at ' + pre.path +
      (pre.is_placeholder ? ' (still a placeholder path; set hf_master_path in the private config)' : '') +
      '; missing: ' + (pre.missing.join(', ') || 'none') +
      '; has_safetensors=' + pre.has_safetensors
    );
  }
  return pre;
}

module.exports = { preflightHfMaster, assertHfMasterReady, splitPipeList };
