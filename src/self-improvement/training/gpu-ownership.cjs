'use strict';

// Host GPU ownership lock + state machine.
//
// Exactly one consumer may own the host GPU at a time: live Ollama cognition,
// HF/QLoRA training, HF REM inference, or vision. The lock is persisted so the
// owner survives process restarts, and transfers are explicit. This prevents
// training, live cognition, REM inference, and vision from simultaneously
// claiming the RTX 3060. All owners/paths originate in chat YAML.

const fs = require('node:fs');
const path = require('node:path');

const { loadSelfImprovementConfig } = require('../config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function lockPath(config) {
  return config.gpu_ownership_lock_file;
}

function readOwner(config = loadSelfImprovementConfig()) {
  const p = lockPath(config);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeOwner(record, config) {
  const p = lockPath(config);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function validOwner(owner, config) {
  return splitPipeList(config.gpu_owners).includes(owner);
}

// Acquire the GPU for an owner. Fails if a DIFFERENT owner currently holds it
// (exclusivity). Re-acquiring as the same owner is idempotent.
function buildRecord(owner, options) {
  return {
    marker: 'FLOKI_V2_GPU_OWNER',
    owner,
    acquired_at: new Date().toISOString(),
    pid: process.pid,
    reason: options.reason || null,
    run_id: options.run_id || null
  };
}

function acquire(owner, options = {}, config = loadSelfImprovementConfig()) {
  if (!validOwner(owner, config)) throw new Error('unknown GPU owner: ' + owner);
  const current = readOwner(config);
  if (current && current.owner && current.owner !== owner) {
    throw new Error('GPU is already owned by ' + current.owner + '; cannot grant to ' + owner);
  }
  const record = buildRecord(owner, options);
  writeOwner(record, config);
  return Object.freeze(record);
}

// Transfer ownership from one owner to another atomically (e.g. training ->
// hf_rem_inference before a REM cycle, then back).
function transfer(fromOwner, toOwner, options = {}, config = loadSelfImprovementConfig()) {
  if (!validOwner(toOwner, config)) throw new Error('unknown GPU owner: ' + toOwner);
  const current = readOwner(config);
  const heldBy = current && current.owner ? current.owner : null;
  if (heldBy !== fromOwner) {
    throw new Error('GPU transfer expected current owner ' + fromOwner + ' but found ' + heldBy);
  }
  // Sanctioned handoff: write the new owner directly (bypassing acquire's
  // same-owner exclusivity guard, which would otherwise reject the change).
  const record = buildRecord(toOwner, options);
  writeOwner(record, config);
  return Object.freeze(record);
}

// Release ownership. Only the current owner may release (defensive).
function release(owner, config = loadSelfImprovementConfig()) {
  const current = readOwner(config);
  if (current && current.owner && current.owner !== owner) {
    throw new Error('GPU release by non-owner ' + owner + '; current owner is ' + current.owner);
  }
  const p = lockPath(config);
  fs.rmSync(p, { force: true });
  return true;
}

function currentOwner(config = loadSelfImprovementConfig()) {
  const current = readOwner(config);
  return current && current.owner ? current.owner : null;
}

function assertOwnedBy(owner, config = loadSelfImprovementConfig()) {
  const held = currentOwner(config);
  if (held !== owner) {
    throw new Error('expected GPU owner ' + owner + ' but found ' + (held || 'none'));
  }
  return true;
}

module.exports = {
  acquire,
  transfer,
  release,
  readOwner,
  currentOwner,
  assertOwnedBy,
  validOwner,
  lockPath,
  splitPipeList
};
