'use strict';

// Hugging Face master checkpoint preflight.
//
// The local HF safetensors checkpoint is the immutable trainable master lineage.
// Training must not start until the master is verified present and complete.
// This module only READS; it never modifies the master. All paths from chat YAML.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

// Container-engine preflight for GPU training. Podman 4.x cannot parse the
// NVIDIA CDI spec v0.7.0 ("unresolvable CDI devices nvidia.com/gpu=all"),
// which silently killed the whole 2026-07-05 nightly training window. The
// engine's --version output is parsed and compared to
// training_engine_min_major; engines that do not report a parseable version
// (contract-test fakes) skip the check rather than fail it.
function preflightTrainingEngine(config = loadSelfImprovementConfig(), options = {}) {
  const execute = options.spawnSync || spawnSync;
  const result = {
    marker: 'FLOKI_V2_TRAINING_ENGINE_PREFLIGHT',
    engine: config.sandbox_engine,
    min_major: Number(config.training_engine_min_major),
    version: null,
    major: null,
    version_parseable: false,
    checked: false,
    ok: true
  };
  let probe;
  try {
    probe = execute(config.sandbox_engine, ['--version'], {
      encoding: 'utf8',
      timeout: Number(config.podman_command_timeout_ms),
      maxBuffer: Number(config.podman_output_buffer_bytes)
    });
  } catch (_error) {
    return Object.freeze(result);
  }
  if (!probe || probe.error || probe.status !== 0) return Object.freeze(result);
  const match = String(probe.stdout || '').match(/version\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) return Object.freeze(result);
  result.version = match[0].replace(/^version\s+/i, '');
  result.major = Number(match[1]);
  result.version_parseable = true;
  result.checked = true;
  result.ok = result.major >= result.min_major;
  return Object.freeze(result);
}

function assertTrainingEngineReady(config = loadSelfImprovementConfig(), options = {}) {
  const pre = preflightTrainingEngine(config, options);
  if (!pre.ok) {
    throw new Error(
      'FLOKI_V2_TRAINING_ENGINE_CDI_INCAPABLE: ' + pre.engine +
      ' reports version ' + pre.version + ' but GPU training requires major >= ' +
      String(pre.min_major) + ' to parse the NVIDIA CDI spec (nvidia.com/gpu=all). ' +
      'Point self_improvement.sandbox_engine at a CDI-capable podman (e.g. ' +
      '~/.local/bin/floki-rsi-podman -> podman 6).'
    );
  }
  return pre;
}

module.exports = {
  preflightHfMaster,
  assertHfMasterReady,
  preflightTrainingEngine,
  assertTrainingEngineReady,
  splitPipeList
};
