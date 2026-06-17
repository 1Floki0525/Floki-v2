'use strict';

/**
 * Floki-v2 brain module contract utilities.
 *
 * Every brain module must declare:
 * - real responsibility
 * - accepted inputs
 * - produced outputs
 * - state reads
 * - state writes
 * - diagnostics
 * - failure modes
 *
 * A module name existing in the folder tree is not enough.
 * The contract has to be machine-checkable.
 */

const { nowIso } = require('../util/time.cjs');

const MODULE_NAMES = Object.freeze([
  'amygdala',
  'broca',
  'cerebellum',
  'emotions_base',
  'frontal',
  'hippocampus',
  'occipital',
  'temporal',
  'thalamus',
  'personality',
  'pineal'
]);

const CONTRACT_VERSION = 'floki-v2-brain-module-contract-v1';

function assertPlainObject(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be a plain object`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

function assertNonEmptyArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty array`);
  }
}

function assertKnownModuleName(name) {
  assertNonEmptyString(name, 'module name');

  if (!MODULE_NAMES.includes(name)) {
    throw new Error(`unknown brain module name: ${name}`);
  }

  return true;
}

function cloneJsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function createModuleContract(input) {
  assertPlainObject(input, 'module contract input');
  assertKnownModuleName(input.name);

  const contract = {
    contract_version: CONTRACT_VERSION,
    module: input.name,
    production: input.production === true,
    created_at: input.created_at || nowIso(),
    responsibility: input.responsibility,
    inputs: input.inputs,
    outputs: input.outputs,
    state_reads: input.state_reads,
    state_writes: input.state_writes,
    diagnostics: input.diagnostics,
    failure_modes: input.failure_modes,
    forbidden: Array.isArray(input.forbidden) ? input.forbidden.slice() : [],
    notes: typeof input.notes === 'string' ? input.notes : ''
  };

  validateModuleContract(contract);
  return Object.freeze(cloneJsonSafe(contract));
}

function validateModuleContract(contract) {
  assertPlainObject(contract, 'module contract');

  if (contract.contract_version !== CONTRACT_VERSION) {
    throw new Error(`invalid module contract version: ${contract.contract_version}`);
  }

  assertKnownModuleName(contract.module);

  if (contract.production !== true) {
    throw new Error(`${contract.module} contract must be marked production=true`);
  }

  assertNonEmptyString(contract.created_at, 'created_at');
  assertNonEmptyString(contract.responsibility, 'responsibility');

  assertNonEmptyArray(contract.inputs, 'inputs');
  assertNonEmptyArray(contract.outputs, 'outputs');
  assertNonEmptyArray(contract.state_reads, 'state_reads');
  assertNonEmptyArray(contract.state_writes, 'state_writes');
  assertNonEmptyArray(contract.diagnostics, 'diagnostics');
  assertNonEmptyArray(contract.failure_modes, 'failure_modes');

  if (!Array.isArray(contract.forbidden)) {
    throw new TypeError('forbidden must be an array');
  }

  const serialized = JSON.stringify(contract).toLowerCase();
  const bannedMarkers = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  for (const marker of bannedMarkers) {
    if (serialized.includes(marker)) {
      throw new Error(`module contract contains banned reasoning marker: ${marker}`);
    }
  }

  return true;
}

function makeModuleDiagnostic(moduleName, status, details = {}) {
  assertKnownModuleName(moduleName);
  assertNonEmptyString(status, 'diagnostic status');
  assertPlainObject(details, 'diagnostic details');

  return {
    created_at: nowIso(),
    module: moduleName,
    status,
    details
  };
}

function makeModuleFailure(moduleName, code, message, details = {}) {
  assertKnownModuleName(moduleName);
  assertNonEmptyString(code, 'failure code');
  assertNonEmptyString(message, 'failure message');
  assertPlainObject(details, 'failure details');

  return {
    created_at: nowIso(),
    module: moduleName,
    ok: false,
    code,
    message,
    details
  };
}

module.exports = {
  MODULE_NAMES,
  CONTRACT_VERSION,
  assertPlainObject,
  assertNonEmptyString,
  assertNonEmptyArray,
  assertKnownModuleName,
  createModuleContract,
  validateModuleContract,
  makeModuleDiagnostic,
  makeModuleFailure
};
