'use strict';

/**
 * Floki-v2 ID utilities.
 *
 * Purpose:
 * - Create durable, readable, collision-resistant IDs.
 * - Create deterministic fingerprints for provenance and diagnostics.
 *
 * IDs are intentionally not meaningful identity claims. They are record locators.
 */

const crypto = require('node:crypto');

const SAFE_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const SAFE_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}_[0-9]{8}t[0-9]{9}z_[a-f0-9]{12}$/;

function normalizePrefix(prefix) {
  if (typeof prefix !== 'string') {
    throw new TypeError('ID prefix must be a string');
  }

  const normalized = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  if (!SAFE_PREFIX_PATTERN.test(normalized)) {
    throw new TypeError(`unsafe ID prefix: ${prefix}`);
  }

  return normalized;
}

function timestampSlug(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('timestampSlug requires a valid Date');
  }

  return date
    .toISOString()
    .replace(/-/g, '')
    .replace(/:/g, '')
    .replace('.', '')
    .replace('T', 't')
    .replace('Z', 'z')
    .toLowerCase();
}

function randomHex(bytes = 6) {
  if (!Number.isInteger(bytes) || bytes < 3 || bytes > 32) {
    throw new TypeError('randomHex byte count must be an integer from 3 to 32');
  }

  return crypto.randomBytes(bytes).toString('hex');
}

function newId(prefix = 'id', date = new Date()) {
  return `${normalizePrefix(prefix)}_${timestampSlug(date)}_${randomHex(6)}`;
}

function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function assertSafeId(value, fieldName = 'id') {
  if (!isSafeId(value)) {
    throw new TypeError(`${fieldName} is not a safe Floki-v2 ID`);
  }

  return true;
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize non-finite numbers');
      }
    }
    return value;
  }

  if (seen.has(value)) {
    throw new TypeError('Cannot canonicalize circular structures');
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, seen));
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item !== 'undefined' && typeof item !== 'function' && typeof item !== 'symbol') {
      result[key] = canonicalize(item, seen);
    }
  }

  seen.delete(value);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value, length = 16) {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new TypeError('fingerprint length must be an integer from 8 to 64');
  }

  const hash = crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');

  return hash.slice(0, length);
}

function eventId() {
  return newId('event');
}

function outputId() {
  return newId('output');
}

function memoryId() {
  return newId('memory');
}

function diagnosticId() {
  return newId('diag');
}

module.exports = {
  SAFE_PREFIX_PATTERN,
  SAFE_ID_PATTERN,
  normalizePrefix,
  timestampSlug,
  randomHex,
  newId,
  isSafeId,
  assertSafeId,
  canonicalize,
  canonicalJson,
  fingerprint,
  eventId,
  outputId,
  memoryId,
  diagnosticId
};
