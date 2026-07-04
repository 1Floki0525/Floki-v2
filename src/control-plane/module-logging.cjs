'use strict';

/**
 * Per-module current-week logging foundation.
 *
 * Derives or creates one stable current-week log file per module in the
 * configured module_log_dir. Uses the central runtime log, module-specific
 * logs, scheduler log, and RSI logs as sources. Each module always has a
 * stable current-week file, even if empty, with an honest header/empty
 * message.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT, getPathConfig, getControlPlaneConfig } = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');
const { getModuleConfig, getRuntimeDir, LOG_KEYS } = require('./module-registry.cjs');

function loadSelfImprovementConfig() {
  const { loadSelfImprovementConfig: loader } = require('../self-improvement/config.cjs');
  return loader();
}

function selfImprovementWorkerLog() {
  const config = loadSelfImprovementConfig();
  const candidate = path.resolve(config.runtime_root, config.worker_log_name);
  return fs.existsSync(candidate) ? candidate : null;
}

function safeDirectSandboxLog(config, candidate) {
  if (!candidate) return null;
  const expectedName = config.sandbox_log_file_name || 'sandbox.log';
  try {
    const resolved = fs.realpathSync(path.resolve(candidate));
    const root = fs.realpathSync(config.workspace_root);
    if (!resolved.startsWith(root + path.sep)) return null;
    if (path.basename(resolved) !== expectedName) return null;
    const parent = path.dirname(resolved);
    if (path.dirname(parent) !== root) return null;
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch (_error) {
    return null;
  }
}

function selfImprovementSandboxLog() {
  const config = loadSelfImprovementConfig();
  const statusFile = path.join(config.runtime_root, config.status_file_name);
  let status = {};
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (_error) { status = {}; }
  const candidate = status?.last_sandbox_log_file ? String(status.last_sandbox_log_file) : null;
  return safeDirectSandboxLog(config, candidate);
}

function currentWeekStamp(nowValue = new Date()) {
  const now = new Date(nowValue);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = now.getDay();
  const date = now.getDate();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(date - day);
  const startMonth = String(startOfWeek.getMonth() + 1).padStart(2, '0');
  const startDate = String(startOfWeek.getDate()).padStart(2, '0');
  return `${year}-${month}_week-starting-${startOfWeek.getFullYear()}-${startMonth}-${startDate}`;
}

function weekLogDir() {
  const config = getControlPlaneConfig('chat');
  const runtimeDir = getRuntimeDir();
  return path.resolve(runtimeDir, config.module_log_subdir);
}

function moduleWeekFileName(moduleKey, nowValue) {
  return `${moduleKey}.${currentWeekStamp(nowValue)}.log`;
}

function moduleWeekFilePath(moduleKey, nowValue) {
  return path.join(weekLogDir(), moduleKey, moduleWeekFileName(moduleKey, nowValue));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readLogTail(filePath, limit) {
  const max = Math.max(0, Number(limit || 0));
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
    return max > 0 ? lines.slice(-max) : lines;
  } catch (_error) {
    return [];
  }
}

function sourceFileForModule(moduleKey, runtimeDir) {
  const stateRoot = path.resolve(PROJECT_ROOT, getPathConfig('chat').state_root || 'state/floki');
  switch (moduleKey) {
    case 'floki_core':
    case 'hearing':
    case 'speech':
    case 'authoritative_api':
      return path.join(runtimeDir, 'chat-local-runtime.log');
    case 'cognition':
    case 'memory':
    case 'emotion':
      return path.join(stateRoot, 'diagnostics.jsonl');
    case 'vision':
      return path.join(runtimeDir, 'chat-webcam-vision.log');
    case 'sleep_scheduler':
    case 'dream_engine':
      return path.join(runtimeDir, 'sleep-cycle-scheduler.log');
    case 'live_event_stream':
      return path.join(runtimeDir, 'chat-local-runtime.log');
    case 'rsi':
      return selfImprovementWorkerLog() || selfImprovementSandboxLog() || null;
    default:
      return null;
  }
}

function formatWeekHeader(moduleKey) {
  return `# Floki-v2 module log :: ${moduleKey} :: week ${currentWeekStamp()} :: created ${nowIso()}`;
}

function formatEmptyMessage(moduleKey) {
  return `# no log activity captured for ${moduleKey} this week`;
}

const REDACTION_PATTERNS = Object.freeze([
  /"(?:authorization|cookie|set-cookie)"\s*:\s*"(?:Bearer\s+)?[^"]+"/gi,
  /(?:authorization|cookie|set-cookie)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
  /"(?:api[_-]?key|token|secret|password|credential)"\s*:\s*"[^"]{8,}"/gi,
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /Bearer\s+[A-Za-z0-9+/_=.-]{16,}/g
]);

function redactModuleLogText(value) {
  let text = String(value || '');
  for (const pattern of REDACTION_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

function cleanupOldModuleWeekFiles(moduleKey, retainWeeks) {
  const retain = Math.max(1, Number(retainWeeks || 1));
  const files = listModuleWeekFiles(moduleKey);
  const keep = new Set(files.slice(-retain));
  for (const file of files) {
    if (!keep.has(file)) fs.rmSync(file, { force: true });
  }
}

function getCurrentWeekFile(moduleKey) {
  if (!Object.keys(LOG_KEYS).includes(moduleKey)) {
    throw new Error('unknown module key: ' + moduleKey);
  }
  const config = getControlPlaneConfig('chat');
  const runtimeDir = getRuntimeDir();
  const dir = ensureDir(path.join(weekLogDir(), moduleKey));
  const filePath = path.join(dir, moduleWeekFileName(moduleKey));
  cleanupOldModuleWeekFiles(moduleKey, config.module_log_retention_weeks || 1);

  if (!fs.existsSync(filePath)) {
    const source = sourceFileForModule(moduleKey, runtimeDir);
    const maxSourceBytes = Number(config.module_log_max_source_bytes || 2000000);
    let initialLines = [];
    if (source && fs.existsSync(source)) {
      try {
        const content = fs.readFileSync(source, 'utf8');
        const tail = content.slice(-maxSourceBytes);
        initialLines = tail.split(/\r?\n/).filter(Boolean).slice(-Number(config.module_log_max_lines || 4000));
      } catch (_error) {
        initialLines = [];
      }
    }
    fs.writeFileSync(filePath, redactModuleLogText(formatWeekHeader(moduleKey) + '\n' + (initialLines.length ? initialLines.join('\n') + '\n' : formatEmptyMessage(moduleKey) + '\n')), 'utf8');
  }

  return filePath;
}

function ensureModuleWeekLog(moduleKey) {
  const filePath = getCurrentWeekFile(moduleKey);
  return Object.freeze({ module: moduleKey, file: filePath, exists: fs.existsSync(filePath), week: currentWeekStamp() });
}

function getModuleLogTail(moduleKey, limit) {
  const filePath = ensureModuleWeekLog(moduleKey).file;
  return Object.freeze({
    module: moduleKey,
    file: filePath,
    lines: readLogTail(filePath, limit),
    week: currentWeekStamp()
  });
}

function listModuleWeekFiles(moduleKey) {
  const dir = path.join(weekLogDir(), moduleKey);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(moduleKey + '.') && name.endsWith('.log'))
    .map((name) => path.join(dir, name))
    .sort();
}

module.exports = {
  currentWeekStamp,
  getCurrentWeekFile,
  getModuleLogTail,
  ensureModuleWeekLog,
  moduleWeekFilePath,
  weekLogDir,
  readLogTail,
  redactModuleLogText,
  sourceFileForModule,
  listModuleWeekFiles,
  cleanupOldModuleWeekFiles
};
