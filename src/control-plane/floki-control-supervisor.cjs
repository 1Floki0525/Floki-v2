'use strict';

/**
 * Floki-v2 out-of-process lifecycle supervisor.
 *
 * Runs independently of the Floki runtime, Electron, web UI, Android,
 * Authoritative API, and Live Event Stream. It survives a Floki Core
 * stop/reset and owns module start/stop/reset operations from the
 * control plane.
 *
 * Bound only to 127.0.0.1. All internal management routes require a
 * signed Ed25519 request. The private signing key never enters this
 * process; only the configured public key is read.
 */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const {
  PROJECT_ROOT,
  getPathConfig,
  getLiveChatConfig,
  getControlPlaneConfig,
  clearConfigCache
} = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');
const { SUPERVISED_MODULES } = require('./module-registry.cjs');

const MODULE_SCHEMA_VERSION = 'floki-v2-control-supervisor-v1';

const ALLOWED_ACTIONS = Object.freeze(['start', 'stop', 'reset']);

const ALLOWED_MODULES = Object.freeze(Array.from(SUPERVISED_MODULES));

const MODULE_TO_SCRIPTS = Object.freeze({
  floki_core: { start: 'floki-chat-start.sh', stop: 'floki-chat-stop.sh' },
  vision: { start: 'floki-chat-vision-start.sh', stop: 'floki-chat-vision-stop.sh' },
  sleep_scheduler: { start: 'floki-sleep-scheduler-start.sh', stop: 'floki-sleep-scheduler-stop.sh' },
  rsi: { start: 'floki-self-improvement-start.sh', stop: 'floki-self-improvement-stop.sh' }
});

const FULL_RUNTIME_LIFECYCLE_SCRIPTS = Object.freeze(new Set([
  'floki-chat-start.sh',
  'floki-chat-stop.sh'
]));

for (const [moduleKey, operations] of Object.entries(MODULE_TO_SCRIPTS)) {
  if (!SUPERVISED_MODULES.has(moduleKey)) {
    throw new Error('supervisor script mapping is not supervised: ' + moduleKey);
  }
  if (moduleKey === 'floki_core') continue;
  for (const scriptName of Object.values(operations)) {
    if (FULL_RUNTIME_LIFECYCLE_SCRIPTS.has(scriptName)) {
      throw new Error(
        moduleKey + ' must not alias a full-runtime lifecycle script: ' + scriptName
      );
    }
  }
}

const MODULE_TO_STATUS_COMMAND = Object.freeze({
  floki_core: 'floki-chat-status.sh',
  authoritative_api: 'floki-chat-status.sh',
  vision: 'floki-chat-vision-status.sh',
  sleep_scheduler: 'floki-sleep-scheduler-status.sh',
  rsi: 'floki-self-improvement-status.sh'
});

function log(level, message, extra = {}) {
  const entry = {
    timestamp: nowIso(),
    level: String(level || 'info'),
    source: 'floki-control-supervisor',
    message: String(message || ''),
    ...extra
  };
  const line = JSON.stringify(entry);
  console.log(line);
  return line;
}


function nonEmptyString(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : fallback;
}

function resolveProjectPath(value, fallback) {
  const selected = nonEmptyString(value, fallback);
  if (!selected) {
    throw new Error('missing path config value and fallback');
  }
  return path.isAbsolute(selected)
    ? selected
    : path.resolve(PROJECT_ROOT, selected);
}

function resolveRuntimePath(runtimeRoot, value, fallback) {
  const selected = nonEmptyString(value, fallback);
  if (!selected) {
    throw new Error('missing runtime path config value and fallback');
  }
  return path.isAbsolute(selected)
    ? selected
    : path.resolve(runtimeRoot, selected);
}

function loadConfig() {
  clearConfigCache();
  const rawConfig = getControlPlaneConfig('chat') || {};
  const paths = getPathConfig('chat') || {};
  const liveChat = getLiveChatConfig('chat') || {};

  const runtimeRoot = resolveProjectPath(
    paths.chat_runtime_root,
    'state/floki/chat/runtime'
  );

  const config = Object.freeze({
    ...rawConfig,
    supervisor_host: nonEmptyString(rawConfig.supervisor_host, '127.0.0.1'),
    supervisor_port: Number(rawConfig.supervisor_port || 17371),
    supervisor_operation_timeout_ms:
      Number(rawConfig.supervisor_operation_timeout_ms || 360000),
    supervisor_log_subdir:
      nonEmptyString(rawConfig.supervisor_log_subdir, 'control-plane'),
    module_log_subdir:
      nonEmptyString(rawConfig.module_log_subdir, 'control-plane/modules'),
    supervisor_pid_file_name:
      nonEmptyString(rawConfig.supervisor_pid_file_name, 'floki-control-supervisor.pid'),
    supervisor_log_file_name:
      nonEmptyString(rawConfig.supervisor_log_file_name, 'floki-control-supervisor.jsonl'),
    supervisor_private_key_path:
      rawConfig.supervisor_private_key_path || null,
    supervisor_public_key_path:
      rawConfig.supervisor_public_key_path || null
  });

  const logDir = resolveRuntimePath(
    runtimeRoot,
    config.supervisor_log_subdir,
    'control-plane'
  );
  const moduleLogDir = resolveRuntimePath(
    runtimeRoot,
    config.module_log_subdir,
    'control-plane/modules'
  );
  const supervisorPidFile = resolveRuntimePath(
    runtimeRoot,
    config.supervisor_pid_file_name,
    'floki-control-supervisor.pid'
  );
  const logFile = resolveRuntimePath(
    logDir,
    config.supervisor_log_file_name,
    'floki-control-supervisor.jsonl'
  );

  return Object.freeze({
    ...config,
    runtime_root: runtimeRoot,
    log_dir: logDir,
    module_log_dir: moduleLogDir,
    supervisor_pid_file: supervisorPidFile,
    log_file: logFile,
    runtime_host: nonEmptyString(liveChat.runtime_host, '127.0.0.1'),
    runtime_port: Number(liveChat.runtime_port || 17370)
  });
}

function ensureDirs(config) {
  fs.mkdirSync(config.runtime_root, { recursive: true });
  fs.mkdirSync(config.log_dir, { recursive: true });
  fs.mkdirSync(config.module_log_dir, { recursive: true });
}

function writePid(config) {
  const temp = config.supervisor_pid_file + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, String(process.pid) + '\n');
  fs.renameSync(temp, config.supervisor_pid_file);
}

function appendToLog(config, line) {
  try {
    fs.appendFileSync(config.log_file, line + '\n');
  } catch (error) {
    log('error', 'failed to append supervisor log', { error: error.message });
  }
}

function readPublicKey(publicKeyPath) {
  if (!publicKeyPath) return null;
  const expanded = String(publicKeyPath).replace(/^~(?=\/)/, process.env.HOME || '');
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(PROJECT_ROOT, expanded);
  if (!fs.existsSync(resolved)) return null;
  const raw = fs.readFileSync(resolved, 'utf8').trim();
  if (!raw) return null;
  return Buffer.from(raw, 'base64');
}

function parseAuthHeader(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value.toLowerCase().startsWith('floki-ed25519 ')) return null;
  const rest = value.slice('floki-ed25519 '.length).trim();
  const parts = rest.split(';').map((part) => part.trim());
  const result = { raw: rest };
  for (const part of parts) {
    const equalIndex = part.indexOf('=');
    if (equalIndex < 0) continue;
    const key = part.slice(0, equalIndex).trim();
    let val = part.slice(equalIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function bodyHash(body) {
  const canonical = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function normalizeSignature(signature) {
  if (!signature) return null;
  try {
    return Buffer.from(String(signature).replace(/\s+/g, ''), 'base64');
  } catch (_error) {
    return null;
  }
}

function buildSignedMessage(method, moduleKey, action, timestamp, nonce, bodyHashValue) {
  const parts = [
    method.toUpperCase(),
    String(moduleKey || ''),
    String(action || ''),
    String(timestamp || ''),
    String(nonce || ''),
    String(bodyHashValue || '')
  ];
  return parts.join('|');
}

function verifySignature(publicKey, message, signature) {
  if (!publicKey || publicKey.length !== 32) return false;
  const sig = normalizeSignature(signature);
  if (!sig || sig.length !== 64) return false;
  try {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const fullPublicKey = Buffer.concat([spkiPrefix, publicKey]);
    const keyObject = crypto.createPublicKey({ key: fullPublicKey, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, sig);
  } catch (_error) {
    return false;
  }
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function createNonceCache(windowSeconds) {
  const windowMs = Math.max(1, Number(windowSeconds || 300)) * 1000;
  const entries = new Map();

  function prune(now) {
    const cutoff = now - windowMs;
    for (const [key, timestamp] of entries) {
      if (timestamp < cutoff) entries.delete(key);
    }
  }

  function has(nonce, timestamp) {
    const key = String(nonce || '') + ':' + String(timestamp || '');
    prune(Date.now());
    return entries.has(key);
  }

  function add(nonce, timestamp) {
    const key = String(nonce || '') + ':' + String(timestamp || '');
    prune(Date.now());
    entries.set(key, Date.now());
    return true;
  }

  function size() {
    prune(Date.now());
    return entries.size;
  }

  return Object.freeze({ has, add, size });
}


async function pollStatusUntil(
  readStatus,
  expectedStatus,
  timeoutMs,
  pollMs,
  options = {}
) {
  if (typeof readStatus !== 'function') {
    throw new TypeError('readStatus must be a function');
  }

  const expected = String(expectedStatus || '');
  if (!expected) {
    throw new TypeError('expectedStatus must be non-empty');
  }

  const now = typeof options.now === 'function'
    ? options.now
    : Date.now;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (delayMs) =>
        new Promise((resolve) => setTimeout(resolve, delayMs));

  const timeout = Math.max(0, Number(timeoutMs || 0));
  const pollInterval = Math.max(1, Number(pollMs || 1));
  const deadline = now() + timeout;
  let attempts = 0;
  let observedStatus = 'unknown';

  while (true) {
    attempts += 1;
    observedStatus = String(
      (await readStatus()) || 'unknown'
    );

    if (observedStatus === expected) {
      return Object.freeze({
        verified: true,
        observedStatus,
        expectedStatus: expected,
        attempts
      });
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return Object.freeze({
        verified: false,
        observedStatus,
        expectedStatus: expected,
        attempts
      });
    }

    await sleep(Math.min(pollInterval, remaining));
  }
}

function createSupervisor(options = {}) {
  const config = loadConfig();
  ensureDirs(config);
  writePid(config);

  const nonceCache = createNonceCache(config.supervisor_nonce_window_seconds);
  const moduleLocks = new Map();
  const state = {
    generation: 0,
    started_at: nowIso()
  };

  const publicKey = readPublicKey(options.public_key_path || process.env.FLOKI_CONTROL_PLANE_PUBLIC_KEY);

  function acquireLock(moduleKey) {
    let lock = moduleLocks.get(moduleKey);
    if (!lock) {
      lock = { promise: Promise.resolve(), running: false };
      moduleLocks.set(moduleKey, lock);
    }
    return lock;
  }

  async function withModuleLock(moduleKey, fn) {
    const lock = acquireLock(moduleKey);
    const next = lock.promise.then(async () => {
      lock.running = true;
      try {
        return await fn();
      } finally {
        lock.running = false;
      }
    });
    lock.promise = next.then(() => undefined, () => undefined);
    return next;
  }

  function isLocked(moduleKey) {
    const lock = moduleLocks.get(moduleKey);
    return lock ? lock.running : false;
  }

  async function verifyRequest(req, body) {
    const parsed = parseAuthHeader(req.headers.authorization);
    if (!parsed || !parsed.signature || !parsed.timestamp || !parsed.nonce || !parsed.module || !parsed.action) {
      return { ok: false, reason: 'missing authorization parameters' };
    }

    const moduleKey = parsed.module;
    const action = parsed.action;
    const timestamp = Number(parsed.timestamp);
    const nonce = parsed.nonce;

    if (!ALLOWED_MODULES.includes(moduleKey)) {
      return { ok: false, reason: 'unknown module key' };
    }
    if (!ALLOWED_ACTIONS.includes(action)) {
      return { ok: false, reason: 'unknown action' };
    }
    if (!Number.isFinite(timestamp)) {
      return { ok: false, reason: 'invalid timestamp' };
    }

    const now = Date.now();
    const skewMs = Math.max(1000, Number(config.supervisor_signature_skew_seconds || 30) * 1000);
    if (Math.abs(now - timestamp) > skewMs) {
      return { ok: false, reason: 'request timestamp outside skew window' };
    }
    if (nonceCache.has(nonce, timestamp)) {
      return { ok: false, reason: 'replayed nonce' };
    }

    const requestMethod = String(req.method || 'GET').toUpperCase();
    const actualBodyHash = bodyHash(body);
    const message = buildSignedMessage(requestMethod, moduleKey, action, timestamp, nonce, actualBodyHash);

    if (!publicKey) {
      return { ok: false, reason: 'public key not configured' };
    }
    if (!verifySignature(publicKey, message, parsed.signature)) {
      return { ok: false, reason: 'signature verification failed' };
    }

    nonceCache.add(nonce, timestamp);
    return { ok: true, module: moduleKey, action, timestamp, nonce, body_hash: actualBodyHash };
  }

  function healthStatus() {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_CONTROL_SUPERVISOR_HEALTH',
      schema_version: MODULE_SCHEMA_VERSION,
      generation: state.generation,
      started_at: state.started_at,
      now: nowIso(),
      bound_host: config.supervisor_host,
      bound_port: config.supervisor_port,
      local_socket_path: config.supervisor_local_socket_path,
      nonce_cache_size: nonceCache.size(),
      locked_modules: Array.from(moduleLocks.keys()).filter(isLocked)
    });
  }

  function buildResult(moduleKey, action, previousStatus, statusValue, changed, message, safeError, operationId) {
    return Object.freeze({
      ok: true,
      verified: true,
      module: moduleKey,
      action,
      changed,
      previousStatus,
      status: statusValue,
      lifecycleState: statusValue,
      health: healthStatus(),
      message,
      safeError,
      operationId,
      generation: state.generation
    });
  }

  function runScript(scriptName, timeoutMs) {
    const scriptPath = path.join(PROJECT_ROOT, 'bin', scriptName);
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, error: 'script not found: ' + scriptName };
    }
    return new Promise((resolve) => {
      const child = spawn('bash', [scriptPath], {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, Math.max(1000, Number(timeoutMs || config.supervisor_operation_timeout_ms || 360000)));
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          exit_code: code,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      });
    });
  }

  function runScriptSync(scriptName, timeoutMs) {
    const scriptPath = path.join(PROJECT_ROOT, 'bin', scriptName);
    if (!fs.existsSync(scriptPath)) {
      return { ok: false, error: 'script not found: ' + scriptName };
    }
    const result = spawnSync('bash', [scriptPath], {
      cwd: PROJECT_ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: Math.max(1000, Number(timeoutMs || config.supervisor_operation_timeout_ms || 360000))
    });
    return {
      ok: result.status === 0,
      exit_code: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim()
    };
  }

  function runtimeApiReady() {
    return new Promise((resolve) => {
      const request = http.get({
        host: config.runtime_host,
        port: config.runtime_port,
        path: '/status',
        timeout: 3000
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const payload = JSON.parse(body);
            resolve(payload.api_ready === true && payload.brain_loaded === true);
          } catch (_error) {
            resolve(false);
          }
        });
      });
      request.on('error', () => resolve(false));
      request.on('timeout', () => { request.destroy(); resolve(false); });
    });
  }

  async function pollModuleStatus(
    moduleKey,
    expectedStatus,
    timeoutMs,
    pollMs
  ) {
    return pollStatusUntil(
      () => statusForModule(moduleKey),
      expectedStatus,
      timeoutMs,
      pollMs
    );
  }

  async function statusForModule(moduleKey) {
    if (['memory', 'emotion', 'cognition'].includes(moduleKey)) {
      const ready = await runtimeApiReady();
      return ready ? 'running' : 'stopped';
    }
    const statusScript = MODULE_TO_STATUS_COMMAND[moduleKey];
    if (!statusScript) return 'unknown';
    const result = runScriptSync(statusScript, config.lifecycle_verify_timeout_ms);
    if (!result.ok) return 'stopped';
    try {
      const parsed = JSON.parse(result.stdout || '{}');
      if (parsed.ok === true && parsed.active === true) return 'running';
      if (parsed.ok === true && parsed.status && parsed.status.worker_running === true) return 'running';
      if (parsed.active === false) return 'stopped';
      if (parsed.ok === false) return 'stopped';
      return parsed.runtime && parsed.runtime.api_ready ? 'running' : 'stopped';
    } catch (_error) {
      return 'stopped';
    }
  }

  async function performStart(moduleKey) {
    const scripts = MODULE_TO_SCRIPTS[moduleKey];
    if (!scripts || !scripts.start) {
      return { ok: false, error: 'no start script for ' + moduleKey };
    }
    const previous = await statusForModule(moduleKey);
    if (previous === 'running') {
      return { ok: true, verified: true, changed: false, previousStatus: previous, status: 'running', message: moduleKey + ' is already running' };
    }
    const result = await runScript(scripts.start, config.supervisor_operation_timeout_ms);
    if (!result.ok) {
      return { ok: false, error: result.stderr || result.stdout || 'start script failed' };
    }
    const verifyTimeout = Number(
      config.lifecycle_verify_timeout_ms || 30000
    );
    const verifyPoll = Number(
      config.lifecycle_verify_poll_ms || 500
    );
    const verification = await pollModuleStatus(
      moduleKey,
      'running',
      verifyTimeout,
      verifyPoll
    );
    const statusValue = verification.verified
      ? 'running'
      : 'degraded';
    return {
      ok: verification.verified === true,
      verified: verification.verified === true,
      changed: true,
      previousStatus: previous,
      status: statusValue,
      error: verification.verified === true
        ? null
        : moduleKey + ' start could not be verified',
      message:
        moduleKey +
        ' start accepted; verified=' +
        String(verification.verified) +
        ' observed_status=' +
        verification.observedStatus
    };
  }

  async function performStop(moduleKey) {
    const scripts = MODULE_TO_SCRIPTS[moduleKey];
    if (!scripts || !scripts.stop) {
      return { ok: false, error: 'no stop script for ' + moduleKey };
    }
    const previous = await statusForModule(moduleKey);
    if (previous === 'stopped') {
      return { ok: true, verified: true, changed: false, previousStatus: previous, status: 'stopped', message: moduleKey + ' is already stopped' };
    }
    const result = await runScript(scripts.stop, config.supervisor_operation_timeout_ms);
    if (!result.ok) {
      return { ok: false, error: result.stderr || result.stdout || 'stop script failed' };
    }
    const verifyTimeout = Number(
      config.lifecycle_verify_timeout_ms || 30000
    );
    const verifyPoll = Number(
      config.lifecycle_verify_poll_ms || 500
    );
    const verification = await pollModuleStatus(
      moduleKey,
      'stopped',
      verifyTimeout,
      verifyPoll
    );
    const statusValue = verification.verified
      ? 'stopped'
      : 'degraded';
    return {
      ok: verification.verified === true,
      verified: verification.verified === true,
      changed: true,
      previousStatus: previous,
      status: statusValue,
      error: verification.verified === true
        ? null
        : moduleKey + ' stop could not be verified',
      message:
        moduleKey +
        ' stop accepted; verified=' +
        String(verification.verified) +
        ' observed_status=' +
        verification.observedStatus
    };
  }

  async function performReset(moduleKey) {
    const previous = await statusForModule(moduleKey);
    const stopResult = await performStop(moduleKey);
    if (!stopResult.ok) return stopResult;
    const startResult = await performStart(moduleKey);
    if (!startResult.ok) return startResult;
    return {
      ok: true,
      changed: previous !== startResult.status,
      previousStatus: previous,
      status: startResult.status,
      message: moduleKey + ' reset completed'
    };
  }

  async function handleLifecycle(moduleKey, action) {
    const operationId = newId('op');
    state.generation += 1;

    return withModuleLock(moduleKey, async () => {
      try {
        let result;
        if (action === 'start') result = await performStart(moduleKey);
        else if (action === 'stop') result = await performStop(moduleKey);
        else if (action === 'reset') result = await performReset(moduleKey);
        else result = { ok: false, error: 'unsupported action' };

        if (!result.ok) {
          return Object.freeze({
            ok: false,
            module: moduleKey,
            action,
            changed: false,
            previousStatus: result.previousStatus || 'unknown',
            status: 'error',
            lifecycleState: 'error',
            health: healthStatus(),
            message: result.error,
            safeError: String(result.error || '').slice(0, 500),
            operationId,
            generation: state.generation
          });
        }

        return buildResult(
          moduleKey,
          action,
          result.previousStatus,
          result.status,
          result.changed,
          result.message,
          null,
          operationId
        );
      } catch (error) {
        return Object.freeze({
          ok: false,
          module: moduleKey,
          action,
          changed: false,
          previousStatus: 'unknown',
          status: 'error',
          lifecycleState: 'error',
          health: healthStatus(),
          message: error && error.message ? error.message : String(error),
          safeError: String(error && error.message ? error.message : error).slice(0, 500),
          operationId,
          generation: state.generation
        });
      }
    });
  }

  async function route(req, res, routeOptions = {}) {
    // FLOKI_CONTROL_SUPERVISOR_LOCAL_SOCKET_V1
    const trustedLocal = routeOptions.trusted_local === true;
    const url = new URL(req.url, 'http://' + config.supervisor_host + ':' + String(config.supervisor_port));
    const requestPath = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && (requestPath === '/health' || requestPath === '/status')) {
      sendJson(res, 200, healthStatus());
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const lifecycleMatch = requestPath.match(/^\/modules\/([a-z_][a-z0-9_]*)\/(start|stop|reset)$/);
    if (!lifecycleMatch) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    const moduleKey = lifecycleMatch[1];
    const action = lifecycleMatch[2];
    const body = await readBody(req);
    const verified = trustedLocal
      ? Object.freeze({
          ok: true,
          module: moduleKey,
          action,
          timestamp: Date.now(),
          nonce: 'local-unix-socket',
          body_hash: bodyHash(body),
          auth_mode: 'local_unix_socket'
        })
      : await verifyRequest(req, body);
    if (!verified.ok) {
      sendJson(res, 401, { ok: false, verified: false, error: verified.reason });
      return;
    }

    if (verified.module !== moduleKey || verified.action !== action) {
      sendJson(res, 403, {
        ok: false,
        verified: false,
        error: 'authorized module/action does not match route'
      });
      return;
    }

    appendToLog(config, log('info', 'lifecycle request accepted', {
      module: moduleKey,
      action,
      nonce: verified.nonce,
      timestamp: verified.timestamp,
      body_hash: verified.body_hash,
      auth_mode: verified.auth_mode || 'signed_ed25519_tcp'
    }));

    const lifecycleHandler = typeof routeOptions.handle_lifecycle === 'function'
      ? routeOptions.handle_lifecycle
      : handleLifecycle;
    const result = await lifecycleHandler(moduleKey, action);
    sendJson(res, result.ok ? 200 : 500, result);
  }

  function createServer(serverOptions = {}) {
    return http.createServer((req, res) => {
      route(req, res, serverOptions).catch((error) => {
        appendToLog(config, log('error', 'route error', { error: error.message }));
        sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    });
  }

  function createLocalServer(serverOptions = {}) {
    return createServer({ ...serverOptions, trusted_local: true });
  }

  function removeStaleSocket() {
    const socketPath = config.supervisor_local_socket_path;
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      const current = fs.lstatSync(socketPath);
      if (!current.isSocket()) {
        throw new Error('refusing to replace non-socket path: ' + socketPath);
      }
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  function listen(server, target, host = null) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const ready = () => {
        server.removeListener('error', reject);
        resolve();
      };
      if (host === null) server.listen(target, ready);
      else server.listen(target, host, ready);
    });
  }

  async function startServer() {
    if (config.supervisor_host !== '127.0.0.1') {
      throw new Error('supervisor must bind to 127.0.0.1');
    }
    removeStaleSocket();
    const localServer = createLocalServer();
    const tcpServer = createServer();
    await listen(localServer, config.supervisor_local_socket_path);
    fs.chmodSync(config.supervisor_local_socket_path, 0o600);
    try {
      await listen(tcpServer, config.supervisor_port, config.supervisor_host);
    } catch (error) {
      await new Promise((resolve) => localServer.close(resolve));
      fs.rmSync(config.supervisor_local_socket_path, { force: true });
      throw error;
    }
    appendToLog(config, log('info', 'supervisor listening', {
      host: config.supervisor_host,
      port: config.supervisor_port,
      local_socket_path: config.supervisor_local_socket_path
    }));
    return Object.freeze({
      tcp_server: tcpServer,
      local_server: localServer,
      close(callback) {
        let remaining = 2;
        const done = () => {
          remaining -= 1;
          if (remaining > 0) return;
          fs.rmSync(config.supervisor_local_socket_path, { force: true });
          if (typeof callback === 'function') callback();
        };
        tcpServer.close(done);
        localServer.close(done);
      }
    });
  }

  return Object.freeze({
    config,
    healthStatus,
    verifyRequest,
    handleLifecycle,
    createServer,
    createLocalServer,
    startServer,
    nonceCache,
    isLocked
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node 24 required, got ' + process.version);
  }

  const publicKeyPath = process.argv[2] || process.env.FLOKI_CONTROL_PLANE_PUBLIC_KEY;
  const supervisor = createSupervisor({ public_key_path: publicKeyPath });
  const server = await supervisor.startServer();

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CONTROL_SUPERVISOR_FAIL', error: error.stack || error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  MODULE_SCHEMA_VERSION,
  ALLOWED_MODULES,
  ALLOWED_ACTIONS,
  MODULE_TO_SCRIPTS,
  MODULE_TO_STATUS_COMMAND,
  pollStatusUntil,
  MODULE_TO_SCRIPTS,
  MODULE_TO_STATUS_COMMAND,
  parseAuthHeader,
  buildSignedMessage,
  verifySignature,
  bodyHash,
  createSupervisor
};
