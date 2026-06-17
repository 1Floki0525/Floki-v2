'use strict';

/**
 * Floki-v2 JSONL utilities.
 *
 * Purpose:
 * - Durable append-only logs for diagnostics and memories.
 * - Strict JSONL parsing with line-level failure reporting.
 * - No silent corruption.
 */

const fs = require('node:fs');
const readline = require('node:readline');
const { appendTextFileSync, ensureParentDirSync, existsSync } = require('./fs-safe.cjs');

function stringifyJsonlRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('JSONL record must be a plain object');
  }

  return `${JSON.stringify(record)}\n`;
}

function parseJsonlLine(line, lineNumber = 0) {
  if (typeof line !== 'string') {
    throw new TypeError('JSONL line must be a string');
  }

  if (line.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(line);
  } catch (error) {
    const location = lineNumber > 0 ? ` at line ${lineNumber}` : '';
    throw new Error(`invalid JSONL${location}: ${error.message}`);
  }
}

function appendJsonlSync(filePath, record) {
  appendTextFileSync(filePath, stringifyJsonlRecord(record));
  return filePath;
}

function readJsonlSync(filePath, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : Infinity;
  const allowInvalid = options.allowInvalid === true;

  if (limit < 0) {
    throw new TypeError('readJsonlSync limit must be >= 0');
  }

  if (!existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const records = [];
  const errors = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (records.length >= limit) {
      break;
    }

    const lineNumber = index + 1;
    const line = lines[index];

    if (line.trim() === '') {
      continue;
    }

    try {
      const parsed = parseJsonlLine(line, lineNumber);
      if (parsed !== null) {
        records.push(parsed);
      }
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }

      errors.push({
        line: lineNumber,
        message: error.message
      });
    }
  }

  if (allowInvalid) {
    return {
      records,
      errors
    };
  }

  return records;
}

async function readJsonlStream(filePath, onRecord, options = {}) {
  if (typeof onRecord !== 'function') {
    throw new TypeError('readJsonlStream requires an onRecord function');
  }

  if (!existsSync(filePath)) {
    return {
      ok: true,
      records_read: 0,
      errors: []
    };
  }

  const allowInvalid = options.allowInvalid === true;
  const errors = [];
  let recordsRead = 0;
  let lineNumber = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    lineNumber += 1;

    if (line.trim() === '') {
      continue;
    }

    try {
      const parsed = parseJsonlLine(line, lineNumber);
      if (parsed !== null) {
        recordsRead += 1;
        await onRecord(parsed, lineNumber);
      }
    } catch (error) {
      if (!allowInvalid) {
        throw error;
      }

      errors.push({
        line: lineNumber,
        message: error.message
      });
    }
  }

  return {
    ok: errors.length === 0,
    records_read: recordsRead,
    errors
  };
}

function rotateJsonlIfTooLargeSync(filePath, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('maxBytes must be an integer >= 1024');
  }

  if (!existsSync(filePath)) {
    ensureParentDirSync(filePath);
    return null;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return null;
  }

  const rotatedPath = `${filePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.rotated`;
  fs.renameSync(filePath, rotatedPath);
  ensureParentDirSync(filePath);

  return rotatedPath;
}

module.exports = {
  stringifyJsonlRecord,
  parseJsonlLine,
  appendJsonlSync,
  readJsonlSync,
  readJsonlStream,
  rotateJsonlIfTooLargeSync
};
