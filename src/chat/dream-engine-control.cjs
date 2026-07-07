'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  PROJECT_ROOT: ROOT,
  getPathConfig
} = require('../config/floki-config.cjs');
const {
  ensureDirSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');

const CONTROL_SCHEMA =
  'floki-v2-dream-engine-control-v1';

function runtimeDirFromConfig() {
  const configured = getPathConfig('chat').chat_runtime_root;
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(ROOT, configured);
}

function dreamEngineControlPath(options = {}) {
  const runtimeDir =
    options.runtime_dir || runtimeDirFromConfig();
  return options.control_file ||
    path.join(runtimeDir, 'dream-engine-control.json');
}

function normalizeGeneration(value) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0
    ? generation
    : 0;
}

function defaultDreamEngineControl(options = {}) {
  return Object.freeze({
    schema: CONTROL_SCHEMA,
    enabled: true,
    generation: 0,
    updated_at: null,
    updated_by_pid: null,
    reason: 'default_enabled',
    control_file: dreamEngineControlPath(options),
    chat_mode_only: true,
    game_mode_started: false
  });
}

function normalizeDreamEngineControl(
  value,
  options = {}
) {
  const fallback = defaultDreamEngineControl(options);
  if (!value || typeof value !== 'object') return fallback;

  return Object.freeze({
    schema: CONTROL_SCHEMA,
    enabled: value.enabled !== false,
    generation: normalizeGeneration(value.generation),
    updated_at:
      typeof value.updated_at === 'string'
        ? value.updated_at
        : null,
    updated_by_pid:
      Number.isInteger(Number(value.updated_by_pid)) &&
      Number(value.updated_by_pid) > 0
        ? Number(value.updated_by_pid)
        : null,
    reason:
      typeof value.reason === 'string' &&
      value.reason.trim()
        ? value.reason.trim()
        : 'unspecified',
    control_file: dreamEngineControlPath(options),
    chat_mode_only: true,
    game_mode_started: false
  });
}

function readDreamEngineControl(options = {}) {
  const file = dreamEngineControlPath(options);
  if (!fs.existsSync(file)) {
    return defaultDreamEngineControl(options);
  }

  try {
    return normalizeDreamEngineControl(
      readJsonFileSync(file),
      options
    );
  } catch (error) {
    return Object.freeze({
      ...defaultDreamEngineControl(options),
      read_error:
        error && error.message
          ? error.message
          : String(error)
    });
  }
}

function writeDreamEngineControl(
  enabled,
  options = {}
) {
  const file = dreamEngineControlPath(options);
  ensureDirSync(path.dirname(file));

  const current = readDreamEngineControl(options);
  const record = Object.freeze({
    schema: CONTROL_SCHEMA,
    enabled: enabled === true,
    generation: normalizeGeneration(current.generation) + 1,
    updated_at: new Date().toISOString(),
    updated_by_pid: process.pid,
    reason: String(
      options.reason ||
      (enabled === true
        ? 'lifecycle_start'
        : 'lifecycle_stop')
    ),
    control_file: file,
    chat_mode_only: true,
    game_mode_started: false
  });

  writeJsonFileAtomicSync(file, record);
  return record;
}

module.exports = {
  CONTROL_SCHEMA,
  runtimeDirFromConfig,
  dreamEngineControlPath,
  defaultDreamEngineControl,
  normalizeDreamEngineControl,
  readDreamEngineControl,
  writeDreamEngineControl
};
