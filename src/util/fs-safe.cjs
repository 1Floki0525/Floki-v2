'use strict';

/**
 * Floki-v2 safe filesystem utilities.
 *
 * Purpose:
 * - Keep state writes inside the project tree unless explicitly given a safe base.
 * - Use atomic JSON writes to avoid corrupting identity/memory files.
 * - Avoid fake success: failed reads/writes return structured failure when requested.
 *
 * No model calls. No Minecraft calls. No desktop control.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function assertRelativePath(relativePath, fieldName = 'relativePath') {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }

  if (path.isAbsolute(relativePath)) {
    throw new TypeError(`${fieldName} must be relative, not absolute`);
  }

  const parts = relativePath.split(/[\\/]+/);
  if (parts.includes('..')) {
    throw new TypeError(`${fieldName} must not contain .. path segments`);
  }

  return true;
}

function resolveInside(baseDir, ...segments) {
  if (typeof baseDir !== 'string' || baseDir.trim() === '') {
    throw new TypeError('baseDir must be a non-empty string');
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);

  const relative = path.relative(resolvedBase, resolvedTarget);
  const escapesBase = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

  if (escapesBase) {
    throw new Error(`unsafe path escapes base directory: ${resolvedTarget}`);
  }

  return resolvedTarget;
}

function projectPath(relativePath) {
  assertRelativePath(relativePath);
  return resolveInside(PROJECT_ROOT, relativePath);
}

function statePath(relativePath = '') {
  if (relativePath === '') {
    return projectPath('state/floki');
  }

  assertRelativePath(relativePath);
  return projectPath(path.join('state', 'floki', relativePath));
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureParentDirSync(filePath) {
  ensureDirSync(path.dirname(filePath));
  return filePath;
}

function existsSync(filePath) {
  return fs.existsSync(filePath);
}

function readTextFileSync(filePath, options = {}) {
  const encoding = options.encoding || 'utf8';
  return fs.readFileSync(filePath, encoding);
}

function writeTextFileAtomicSync(filePath, text) {
  if (typeof text !== 'string') {
    throw new TypeError('writeTextFileAtomicSync requires text content as a string');
  }

  ensureParentDirSync(filePath);

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, text, 'utf8');
  fs.renameSync(tempPath, filePath);

  return filePath;
}

function readJsonFileSync(filePath, fallbackValue = undefined) {
  if (!existsSync(filePath)) {
    if (typeof fallbackValue !== 'undefined') {
      return fallbackValue;
    }
    throw new Error(`JSON file does not exist: ${filePath}`);
  }

  const raw = readTextFileSync(filePath);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse JSON file ${filePath}: ${error.message}`);
  }
}

function writeJsonFileAtomicSync(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  return writeTextFileAtomicSync(filePath, json);
}

function appendTextFileSync(filePath, text) {
  if (typeof text !== 'string') {
    throw new TypeError('appendTextFileSync requires text content as a string');
  }

  ensureParentDirSync(filePath);
  fs.appendFileSync(filePath, text, 'utf8');

  return filePath;
}

function backupFileIfExistsSync(filePath, label = 'backup') {
  if (!existsSync(filePath)) {
    return null;
  }

  const safeLabel = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'backup';

  const backupPath = `${filePath}.${safeLabel}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(filePath, backupPath);

  return backupPath;
}

function safeResult(fn) {
  try {
    return {
      ok: true,
      value: fn(),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: {
        name: error.name,
        message: error.message
      }
    };
  }
}

module.exports = {
  PROJECT_ROOT,
  assertRelativePath,
  resolveInside,
  projectPath,
  statePath,
  ensureDirSync,
  ensureParentDirSync,
  existsSync,
  readTextFileSync,
  writeTextFileAtomicSync,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  appendTextFileSync,
  backupFileIfExistsSync,
  safeResult
};
