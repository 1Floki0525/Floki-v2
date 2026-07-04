'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  PROJECT_ROOT,
  getPathConfig,
  getControlPlaneConfig
} = require('../config/floki-config.cjs');
const {
  MODULE_KEYS,
  DISPLAY_NAMES,
  getRuntimeDir
} = require('./module-registry.cjs');
const {
  currentWeekStamp,
  moduleWeekFilePath,
  weekLogDir
} = require('./module-logging.cjs');
const {
  loadSelfImprovementConfig
} = require('../self-improvement/config.cjs');

const EXTRA_LOG_KEYS = Object.freeze([
  'rsi_worker',
  'rsi_sandbox'
]);

const ALL_LOG_KEYS = Object.freeze([
  ...MODULE_KEYS,
  ...EXTRA_LOG_KEYS
]);

const REDACTION_PATTERNS = Object.freeze([
  /"(?:authorization|cookie|set-cookie)"\s*:\s*"(?:Bearer\s+)?[^"]+"/gi,
  /(?:authorization|cookie|set-cookie)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
  /"(?:api[_-]?key|token|secret|password|credential)"\s*:\s*"[^"]{8,}"/gi,
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[^"'\s,;]{8,}/gi,
  /Bearer\s+[A-Za-z0-9+/_=.-]{16,}/g
]);

function redactLogText(value) {
  let text = String(value || '');
  for (const pattern of REDACTION_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

function normalizeLogRequest(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function displayNameForKey(key) {
  if (key === 'rsi_worker') return 'Self-Improvement Worker';
  if (key === 'rsi_sandbox') return 'Self-Improvement Active Sandbox';
  return DISPLAY_NAMES[key] || key;
}

function resolveLogKey(service) {
  const normalized = normalizeLogRequest(service);
  const aliases = new Map([
    ['worker', 'rsi_worker'],
    ['worker_log', 'rsi_worker'],
    ['self_improvement_worker', 'rsi_worker'],
    ['self_improvement_worker_log', 'rsi_worker'],
    ['active', 'rsi_sandbox'],
    ['active_log', 'rsi_sandbox'],
    ['sandbox', 'rsi_sandbox'],
    ['sandbox_log', 'rsi_sandbox'],
    ['self_improvement_sandbox', 'rsi_sandbox'],
    ['self_improvement_active_sandbox', 'rsi_sandbox'],
    ['recursive_self_improvement', 'rsi'],
    ['rsi_lab', 'rsi']
  ]);
  if (aliases.has(normalized)) return aliases.get(normalized);
  if (ALL_LOG_KEYS.includes(normalized)) return normalized;
  for (const key of MODULE_KEYS) {
    if (normalizeLogRequest(DISPLAY_NAMES[key]) === normalized) return key;
  }
  return null;
}

function safeJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function safeExistingFile(filePath) {
  if (!filePath) return null;
  try {
    const resolved = fs.realpathSync(path.resolve(filePath));
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch (_error) {
    return null;
  }
}

function safeSandboxLogFile(config, filePath) {
  if (!filePath) return null;
  try {
    const resolved = fs.realpathSync(path.resolve(filePath));
    const root = fs.realpathSync(config.workspace_root);
    if (!resolved.startsWith(root + path.sep)) return null;
    if (path.basename(resolved) !== config.sandbox_log_file_name) return null;
    const parent = path.dirname(resolved);
    if (path.dirname(parent) !== root) return null;
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch (_error) {
    return null;
  }
}

function newestSandboxLog(config) {
  const status = safeJson(
    path.join(config.runtime_root, config.status_file_name),
    {}
  );
  const recorded = safeSandboxLogFile(config, status?.last_sandbox_log_file);
  if (recorded) return recorded;

  let entries = [];
  try {
    entries = fs.readdirSync(config.workspace_root, {
      withFileTypes: true
    });
  } catch (_error) {
    return null;
  }

  let newest = null;
  let newestMtime = -1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safeExistingFile(
      path.join(
        config.workspace_root,
        entry.name,
        config.sandbox_log_file_name
      )
    );
    if (!candidate) continue;
    const mtime = Number(fs.statSync(candidate).mtimeMs || 0);
    if (mtime > newestMtime) {
      newest = candidate;
      newestMtime = mtime;
    }
  }
  return newest;
}

function sourceFilesForKey(key) {
  const runtimeDir = getRuntimeDir();
  const paths = getPathConfig('chat');
  const stateRoot = path.resolve(
    PROJECT_ROOT,
    paths.state_root || 'state/floki'
  );
  const diagnostics = path.join(
    stateRoot,
    'diagnostics.jsonl'
  );
  const runtimeLog = path.join(
    runtimeDir,
    'chat-local-runtime.log'
  );
  const visionLog = path.join(
    runtimeDir,
    'chat-webcam-vision.log'
  );
  const schedulerLog = path.join(
    runtimeDir,
    'sleep-cycle-scheduler.log'
  );
  const rsiConfig = loadSelfImprovementConfig();
  const workerLog = safeExistingFile(
    path.join(
      rsiConfig.runtime_root,
      rsiConfig.worker_log_name
    )
  );
  const sandboxLog = newestSandboxLog(rsiConfig);

  const map = {
    floki_core: [runtimeLog],
    cognition: [diagnostics],
    vision: [visionLog],
    hearing: [runtimeLog],
    speech: [runtimeLog],
    memory: [diagnostics],
    emotion: [diagnostics],
    sleep_scheduler: [schedulerLog],
    dream_engine: [schedulerLog],
    authoritative_api: [runtimeLog],
    live_event_stream: [runtimeLog],
    web_app: [runtimeLog],
    mobile_app: [runtimeLog],
    rsi: [workerLog, sandboxLog],
    rsi_worker: [workerLog],
    rsi_sandbox: [sandboxLog]
  };

  return (map[key] || [])
    .map(safeExistingFile)
    .filter(Boolean);
}

function weeklyFileForKey(key) {
  if (MODULE_KEYS.includes(key)) {
    return moduleWeekFilePath(key);
  }
  const directory = path.join(
    weekLogDir(),
    key
  );
  return path.join(
    directory,
    `${key}.${currentWeekStamp()}.log`
  );
}

function sourceTail(filePath, maxBytes, maxLines) {
  const stat = fs.statSync(filePath);
  const size = Number(stat.size || 0);
  const start = Math.max(0, size - maxBytes);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, size - start));
    if (buffer.length > 0) {
      fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        start
      );
    }
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines);
  } finally {
    fs.closeSync(descriptor);
  }
}

function formatHeader(key, sources) {
  return [
    `# Floki-v2 current-week log workspace`,
    `# key: ${key}`,
    `# display: ${displayNameForKey(key)}`,
    `# week: ${currentWeekStamp()}`,
    `# refreshed: ${new Date().toISOString()}`,
    `# sources: ${sources.length ? sources.map((item) => path.basename(item)).join(', ') : 'none'}`
  ].join('\n');
}

function synchronizeCurrentWeekLog(key) {
  if (!ALL_LOG_KEYS.includes(key)) {
    throw new Error('unknown log workspace key: ' + key);
  }

  const control = getControlPlaneConfig('chat');
  const maxBytes = Math.max(
    4096,
    Number(control.module_log_max_source_bytes || 2000000)
  );
  const maxLines = Math.max(
    100,
    Number(control.module_log_max_lines || 4000)
  );
  const sources = sourceFilesForKey(key);
  const rows = [];

  for (const source of sources) {
    rows.push(
      `# source: ${source}`
    );
    rows.push(
      ...sourceTail(
        source,
        maxBytes,
        maxLines
      )
    );
  }

  const selected = rows
    .slice(-maxLines);
  const content = redactLogText(
    formatHeader(key, sources) +
      '\n' +
      (
        selected.length
          ? selected.join('\n') + '\n'
          : `# no log activity captured for ${key} this week\n`
      )
  );

  const filePath = weeklyFileForKey(key);
  fs.mkdirSync(
    path.dirname(filePath),
    {
      recursive: true,
      mode: 0o700
    }
  );
  fs.writeFileSync(
    filePath,
    content,
    {
      encoding: 'utf8',
      mode: 0o600
    }
  );
  return filePath;
}

function ensureCurrentWeekWorkspace() {
  return Object.freeze(
    ALL_LOG_KEYS.map((key) => {
      const file = synchronizeCurrentWeekLog(key);
      return Object.freeze({
        key,
        display_name: displayNameForKey(key),
        file,
        week: currentWeekStamp()
      });
    })
  );
}

function readLogWorkspace(service, options = {}) {
  const key = resolveLogKey(service);
  if (!key) {
    return Object.freeze({
      ok: false,
      exists: false,
      service: String(service || ''),
      path: null,
      error: 'unknown log workspace service',
      text: '',
      lines: [],
      week: currentWeekStamp()
    });
  }

  const sources = sourceFilesForKey(key);
  const filePath = synchronizeCurrentWeekLog(key);
  const content = fs.readFileSync(
    filePath,
    'utf8'
  );
  const requestedLimit = Number(
    options.limit || 4000
  );
  const limit = Math.max(
    1,
    Math.min(4000, requestedLimit)
  );
  const lines = content
    .split(/\r?\n/)
    .slice(-limit);
  const text = lines.join('\n');
  const stat = fs.statSync(filePath);

  return Object.freeze({
    ok: true,
    exists: true,
    service: key,
    path: sources[0] || null,
    display_name: displayNameForKey(key),
    file_name: path.basename(filePath),
    week: currentWeekStamp(),
    text,
    lines,
    truncated:
      content.split(/\r?\n/).length > limit,
    size_bytes: Number(stat.size || 0),
    modified_at:
      new Date(stat.mtimeMs).toISOString()
  });
}

module.exports = {
  ALL_LOG_KEYS,
  EXTRA_LOG_KEYS,
  ensureCurrentWeekWorkspace,
  normalizeLogRequest,
  readLogWorkspace,
  redactLogText,
  resolveLogKey,
  synchronizeCurrentWeekLog
};
