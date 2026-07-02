'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadSelfImprovementConfig
} = require('../config.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  const value = Number(pid);

  if (!Number.isInteger(value) || value <= 0) {
    return false;
  }

  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function removeStaleLock(file) {
  const record = readLock(file);

  if (!record || !processAlive(record.pid)) {
    fs.rmSync(file, { force: true });
    return true;
  }

  return false;
}

async function acquireNightlyHfOperationLock(
  kind,
  config = loadSelfImprovementConfig()
) {
  const file = config.nightly_hf_operation_lock_file;
  const timeoutMs = Number(
    config.nightly_hf_operation_lock_timeout_ms
  );
  const pollMs = Number(
    config.nightly_hf_operation_lock_poll_ms
  );

  if (!file) {
    throw new Error(
      'nightly_hf_operation_lock_file is required'
    );
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      'nightly_hf_operation_lock_timeout_ms must be positive'
    );
  }

  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(
      'nightly_hf_operation_lock_poll_ms must be positive'
    );
  }

  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });

  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const descriptor = fs.openSync(
        file,
        'wx',
        0o600
      );

      const record = {
        marker: 'FLOKI_V2_NIGHTLY_HF_OPERATION_LOCK',
        token,
        kind: String(kind || 'unknown'),
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };

      fs.writeFileSync(
        descriptor,
        JSON.stringify(record, null, 2) + '\n'
      );
      fs.closeSync(descriptor);

      return Object.freeze({
        record: Object.freeze(record),
        release() {
          const current = readLock(file);

          if (
            current &&
            current.token &&
            current.token !== token
          ) {
            throw new Error(
              'nightly HF operation lock ownership changed'
            );
          }

          fs.rmSync(file, { force: true });
          return true;
        }
      });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      removeStaleLock(file);
      await sleep(pollMs);
    }
  }

  const holder = readLock(file);

  throw new Error(
    'FLOKI_NIGHTLY_HF_OPERATION_LOCK_TIMEOUT: ' +
    JSON.stringify(holder)
  );
}

async function withNightlyHfOperationLock(
  kind,
  operation,
  config = loadSelfImprovementConfig()
) {
  if (typeof operation !== 'function') {
    throw new TypeError(
      'nightly HF operation must be a function'
    );
  }

  const lease = await acquireNightlyHfOperationLock(
    kind,
    config
  );

  try {
    return await operation(lease.record);
  } finally {
    lease.release();
  }
}

module.exports = {
  acquireNightlyHfOperationLock,
  processAlive,
  readLock,
  removeStaleLock,
  withNightlyHfOperationLock
};
