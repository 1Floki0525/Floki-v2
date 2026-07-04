'use strict';

/**
 * Authoritative module registry shared by status, lifecycle control, logs,
 * local Electron, web, Android, the Authoritative API, and the Live Event Stream.
 *
 * Returns immutable objects. Does not accept shell commands, executable paths,
 * or systemd unit names from clients. Operation resolution is internal and
 * allowlisted by stable snake_case keys.
 */

const path = require('node:path');

const { PROJECT_ROOT, getPathConfig, getLiveChatConfig, getControlPlaneConfig } = require('../config/floki-config.cjs');
const { buildFlokiLifecycleStatus } = require('../chat/floki-lifecycle-status.cjs');
const { readDreamEngineControl } = require('../chat/dream-engine-control.cjs');
const { readChatWebcamVisionStatus } = require('../vision/chat-webcam-vision-service.cjs');
const { readStatus: readRsiStatus } = require('../self-improvement/store.cjs');
const { loadSelfImprovementConfig } = require('../self-improvement/config.cjs');
const { controlFile: clientAppControlFile, readAllClientAppStatuses } = require('./client-app-control.cjs');

const MODULE_KEYS = Object.freeze([
  'floki_core',
  'cognition',
  'vision',
  'hearing',
  'speech',
  'memory',
  'emotion',
  'sleep_scheduler',
  'dream_engine',
  'authoritative_api',
  'live_event_stream',
  'web_app',
  'mobile_app',
  'rsi'
]);

const MODULE_ACTIONS = Object.freeze({
  floki_core: Object.freeze(['start', 'stop', 'reset']),
  authoritative_api: Object.freeze(['start', 'stop', 'reset']),
  cognition: Object.freeze(['start', 'stop', 'reset']),
  vision: Object.freeze(['start', 'stop', 'reset']),
  hearing: Object.freeze(['start', 'stop', 'reset']),
  speech: Object.freeze(['start', 'stop', 'reset']),
  memory: Object.freeze(['start', 'stop', 'reset']),
  emotion: Object.freeze(['start', 'stop', 'reset']),
  sleep_scheduler: Object.freeze(['start', 'stop', 'reset']),
  dream_engine: Object.freeze(['start', 'stop', 'reset']),
  rsi: Object.freeze(['start', 'stop', 'reset']),
  live_event_stream: Object.freeze(['start', 'stop', 'reset']),
  web_app: Object.freeze(['start', 'stop', 'reset']),
  mobile_app: Object.freeze(['start', 'stop', 'reset'])
});

function moduleActions(key) {
  return MODULE_ACTIONS[key] || Object.freeze([]);
}



function freezeRecord(record) {
  return Object.freeze({ ...record });
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (_error) { return false; }
}

function readPidFile(filePath) {
  const fs = require('node:fs');
  try {
    const value = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

function safeFileTime(filePath) {
  const fs = require('node:fs');
  try { return fs.statSync(filePath).mtimeMs; } catch (_error) { return 0; }
}

function uptimeFromFile(filePath) {
  const fs = require('node:fs');
  try {
    const stat = fs.statSync(filePath);
    return Math.max(0, Date.now() - Number(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || Date.now()));
  } catch (_error) {
    return 0;
  }
}

function timestampAgeMs(value, now = Date.now()) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Number(now) - parsed);
}

function classifyRsiModuleStatus(ctx = {}) {
  const s = ctx.rsiStatus || {};
  if (s.enabled === false) return 'stopped';
  if (s.read_error || ctx.rsiReadError) return 'degraded';

  const workerPid = s.worker_pid || ctx.rsiPid || null;
  const workerAlive =
    s.worker_running === true ||
    ctx.rsiPidAlive === true ||
    (workerPid ? processAlive(workerPid) : false);

  if (s.last_error) return 'degraded';
  if (String(s.state || '') === 'stopped' && !workerAlive) return 'stopped';

  if (!workerAlive) return 'degraded';

  const heartbeatAt = s.worker_alive_at || s.last_heartbeat_at || null;
  const staleMs = Number(
    ctx.rsiConfig?.worker_heartbeat_stale_ms ||
    ctx.rsiConfig?.sandbox_heartbeat_stale_ms ||
    0
  );
  const heartbeatAge = timestampAgeMs(heartbeatAt, ctx.now || Date.now());
  if (!heartbeatAt || (staleMs > 0 && heartbeatAge !== null && heartbeatAge > staleMs)) {
    return 'degraded';
  }

  return 'running';
}

function runtimeContext(runtimeDir) {
  const fs = require('node:fs');
  const currentStatus = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(runtimeDir, 'chat-local-runtime.status.json'), 'utf8'));
    } catch (_error) {
      return {};
    }
  })();

  const dreamEngineControl = readDreamEngineControl({ runtime_dir: runtimeDir });
  const lifecycle = buildFlokiLifecycleStatus();
  const webcam = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
  const runtimePid = readPidFile(path.join(runtimeDir, 'chat-local-runtime.pid'));
  const schedulerPid = readPidFile(path.join(runtimeDir, 'sleep-cycle-scheduler.pid'));
  const visionPid = readPidFile(path.join(runtimeDir, 'chat-webcam-vision.pid'));
  const rsiConfig = (() => {
    try { return loadSelfImprovementConfig(); } catch (_error) { return null; }
  })();
  const rsiStatus = (() => {
    try { return readRsiStatus(rsiConfig || undefined); } catch (error) { return { read_error: error.message }; }
  })();
  const rsiRuntimeDir = rsiConfig
    ? rsiConfig.runtime_root
    : path.join(PROJECT_ROOT, getPathConfig('chat').state_root || 'state/floki', 'self-improvement', 'runtime');
  const rsiPid = readPidFile(path.join(rsiRuntimeDir, 'worker.pid'));
  const now = Date.now();
  const clientApps = readAllClientAppStatuses({ runtime_dir: runtimeDir, now_ms: now });

  const hearingError = (currentStatus.hearing && (currentStatus.hearing.last_error || currentStatus.hearing.last_wake_gate_error)) || currentStatus.hearing_start_error || null;
  const visionError = webcam.last_fatal_error || webcam.last_yolo_error || webcam.last_vlm_error || currentStatus.vision_start_error || null;

  return {
    currentStatus,
    lifecycle,
    dreamEngineControl,
    webcam,
    runtimePid,
    schedulerPid,
    visionPid,
    rsiStatus,
    rsiConfig,
    rsiPid: rsiStatus.worker_pid || rsiPid,
    rsiPidAlive: processAlive(rsiStatus.worker_pid || rsiPid),
    clientApps,
    now,
    hearingError,
    visionError
  };
}

const STATUS_SOURCES = Object.freeze({
  floki_core: (ctx) => (ctx.runtimePid && ctx.currentStatus.brain_loaded === true ? 'running' : 'stopped'),
  cognition: (ctx) => (ctx.currentStatus.brain_loaded === true && ctx.currentStatus.cognition_enabled !== false ? 'running' : 'stopped'),
  vision: (ctx) => {
    if (ctx.webcam.capture_live === true) return 'running';
    if (ctx.visionPid && processAlive(ctx.visionPid)) return 'degraded';
    if (ctx.webcam.active === true) return 'degraded';
    return 'stopped';
  },
  hearing: (ctx) => {
    if (ctx.currentStatus.hearing_enabled === false) return 'stopped';
    const sleeping = ctx.currentStatus.lifecycle && ctx.currentStatus.lifecycle.is_awake === false;
    if (sleeping) return 'stopped';
    const hearingSvc = ctx.currentStatus.hearing || {};
    if (hearingSvc.service_state === 'stopping' && !ctx.hearingError) return 'stopped';
    if (hearingSvc.service_state === 'stopped' && !ctx.hearingError) return 'stopped';
    return ctx.currentStatus.hearing_ready === true && !ctx.hearingError ? 'running' : 'degraded';
  },
  speech: (ctx) => {
    const audio = ctx.currentStatus.hearing || {};
    if (audio.speech_enabled === false) return 'stopped';
    const sleeping = ctx.currentStatus.lifecycle && ctx.currentStatus.lifecycle.is_awake === false;
    if (sleeping) return 'stopped';
    return audio.piper_ready === true && audio.playback_ready === true ? 'running' : 'degraded';
  },
  memory: (ctx) => {
    if (ctx.currentStatus.memory_enabled === false) return 'stopped';
    const memoryHealthy = ctx.currentStatus.memory_loaded === true && ctx.currentStatus.knowledge_ready === true;
    return memoryHealthy && !ctx.currentStatus.knowledge_refresh_error ? 'running' : 'degraded';
  },
  emotion: (ctx) => (ctx.currentStatus.emotion_enabled === false ? 'stopped' : 'running'),
  sleep_scheduler: (ctx) => (ctx.schedulerPid && processAlive(ctx.schedulerPid) ? 'running' : 'stopped'),
  dream_engine: (ctx) => {
    const control = ctx.dreamEngineControl || {};
    if (control.read_error) return 'degraded';
    return control.enabled === false ? 'stopped' : 'running';
  },
  authoritative_api: (ctx) => (ctx.currentStatus.api_ready === true ? 'running' : 'stopped'),
  live_event_stream: (ctx) => (
    ctx.currentStatus.live_event_stream_enabled === true &&
    ctx.currentStatus.websocket_ready === true
      ? 'running'
      : 'stopped'
  ),
  web_app: (ctx) => ctx.clientApps.web_app.status,
  mobile_app: (ctx) => ctx.clientApps.mobile_app.status,
  rsi: (ctx) => {
    return classifyRsiModuleStatus(ctx);
  }
});

const DEPENDENCIES = Object.freeze({
  floki_core: Object.freeze([]),
  cognition: Object.freeze(['floki_core']),
  vision: Object.freeze(['floki_core']),
  hearing: Object.freeze(['floki_core']),
  speech: Object.freeze(['floki_core', 'hearing']),
  memory: Object.freeze(['floki_core']),
  emotion: Object.freeze(['floki_core', 'cognition']),
  sleep_scheduler: Object.freeze(['floki_core']),
  dream_engine: Object.freeze(['floki_core', 'sleep_scheduler']),
  authoritative_api: Object.freeze(['floki_core']),
  live_event_stream: Object.freeze(['floki_core', 'authoritative_api']),
  web_app: Object.freeze(['authoritative_api']),
  mobile_app: Object.freeze(['authoritative_api']),
  rsi: Object.freeze(['floki_core', 'authoritative_api'])
});

const DISPLAY_NAMES = Object.freeze({
  floki_core: 'Floki Core',
  cognition: 'Cognition',
  vision: 'Vision',
  hearing: 'Hearing',
  speech: 'Speech',
  memory: 'Memory',
  emotion: 'Emotion',
  sleep_scheduler: 'Sleep Scheduler',
  dream_engine: 'Dream Engine',
  authoritative_api: 'Authoritative API',
  live_event_stream: 'Live Event Stream',
  web_app: 'Web App',
  mobile_app: 'Mobile App',
  rsi: 'RSI'
});

const LOG_KEYS = Object.freeze({
  floki_core: 'floki_core',
  cognition: 'cognition',
  vision: 'vision',
  hearing: 'hearing',
  speech: 'speech',
  memory: 'memory',
  emotion: 'emotion',
  sleep_scheduler: 'sleep_scheduler',
  dream_engine: 'dream_engine',
  authoritative_api: 'authoritative_api',
  live_event_stream: 'live_event_stream',
  web_app: 'web_app',
  mobile_app: 'mobile_app',
  rsi: 'rsi'
});

const SUPERVISED_MODULES = Object.freeze(new Set([
  'floki_core',
  'authoritative_api',
  'vision',
  'sleep_scheduler',
  'rsi'
]));

const IN_PROCESS_MODULES = Object.freeze(new Set([
  'cognition',
  'hearing',
  'speech',
  'memory',
  'emotion',
  'live_event_stream',
  'web_app',
  'mobile_app',
  'dream_engine'
]));

const CLIENT_APP_MODULES = Object.freeze(new Set([
  'web_app',
  'mobile_app'
]));

function getRuntimeDir() {
  return path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root);
}

function getModuleConfig(key) {
  const config = getControlPlaneConfig('chat');
  const runtimeDir = getRuntimeDir();
  const paths = getPathConfig('chat');
  const stateRoot = path.resolve(PROJECT_ROOT, paths.state_root || 'state/floki');

  const ctx = runtimeContext(runtimeDir);
  const statusFn = STATUS_SOURCES[key] || (() => 'unknown');
  const status = statusFn(ctx);

  const rsiRuntimeDir = ctx.rsiConfig?.runtime_root ||
    path.resolve(PROJECT_ROOT, paths.state_root || 'state/floki', 'self-improvement', 'runtime');

  const heartbeatFile = (() => {
    if (key === 'sleep_scheduler') return path.join(runtimeDir, 'sleep-cycle-scheduler.heartbeat.json');
    if (key === 'vision') return path.join(runtimeDir, 'chat-webcam-vision.heartbeat.json');
    if (key === 'rsi') return path.join(rsiRuntimeDir, 'worker.heartbeat.json');
    if (CLIENT_APP_MODULES.has(key)) return clientAppControlFile(runtimeDir);
    return path.join(runtimeDir, 'chat-local-runtime.heartbeat.json');
  })();

  const uptimeFile = (() => {
    if (key === 'sleep_scheduler') return path.join(runtimeDir, 'sleep-cycle-scheduler.pid');
    if (key === 'vision') return path.join(runtimeDir, 'chat-webcam-vision.pid');
    if (key === 'rsi') return path.join(rsiRuntimeDir, 'worker.pid');
    return path.join(runtimeDir, 'chat-local-runtime.pid');
  })();

  const displayName = DISPLAY_NAMES[key];
  const requiresConfirmation = (key === 'floki_core' || key === 'authoritative_api');
  const preserveRuntimePid = key !== 'floki_core';
  const supervised = SUPERVISED_MODULES.has(key);
  const clientApp = CLIENT_APP_MODULES.has(key);
  const clientAppStatus = clientApp ? ctx.clientApps[key] : null;

  const actions = moduleActions(key);
  const operation = (action) => actions.includes(action)
    ? Object.freeze({
        internal: true,
        type: supervised ? 'supervisor' : 'in_process',
        confirmation_required: action === 'stop' && requiresConfirmation
      })
    : null;

  return freezeRecord({
    key,
    name: displayName,
    display_name: displayName,
    status_source: statusFn,
    status,
    start: operation('start'),
    stop: operation('stop'),
    reset: operation('reset'),
    health: Object.freeze({ internal: true, type: supervised ? 'supervisor' : 'in_process' }),
    start_available: actions.includes('start'),
    stop_available: actions.includes('stop'),
    reset_available: actions.includes('reset'),
    restart_available: actions.includes('reset'),
    dependencies: DEPENDENCIES[key],
    log_source: Object.freeze({ runtime_dir: runtimeDir, state_root: stateRoot }),
    log_key: LOG_KEYS[key],
    log_available: true,
    client_app: clientApp,
    client_app_status: clientAppStatus,
    timeout_ms: Number(config.supervisor_operation_timeout_ms || 360000),
    lifecycle_verify_timeout_ms: Number(config.lifecycle_verify_timeout_ms || 30000),
    requires_confirmation: requiresConfirmation,
    preserve_runtime_pid: preserveRuntimePid,
    supervised,
    in_process: IN_PROCESS_MODULES.has(key),
    heartbeat_file: heartbeatFile,
    uptime_file: uptimeFile
  });
}

function getAllModuleConfigs() {
  return Object.freeze(MODULE_KEYS.map((key) => getModuleConfig(key)));
}

function isKnownModule(key) {
  return typeof key === 'string' && MODULE_KEYS.includes(key);
}

function getLifecycleActionShape() {
  return Object.freeze({
    allowed_actions: Object.freeze(['start', 'stop', 'reset']),
    requires_signed_request_for: Object.freeze(Array.from(SUPERVISED_MODULES))
  });
}

function getRegistryMetadata() {
  const config = getControlPlaneConfig('chat');
  return freezeRecord({
    schema_version: 'floki-v2-module-registry-v1',
    keys: MODULE_KEYS,
    modules: getAllModuleConfigs().map((module) => freezeRecord({
      key: module.key,
      name: module.name,
      dependencies: module.dependencies,
      log_key: module.log_key,
      timeout_ms: module.timeout_ms,
      requires_confirmation: module.requires_confirmation,
      preserve_runtime_pid: module.preserve_runtime_pid,
      supervised: module.supervised,
      in_process: module.in_process,
      client_app: module.client_app
    })),
    actions: getLifecycleActionShape(),
    runtime_root: getRuntimeDir(),
    module_log_subdir: path.resolve(getRuntimeDir(), config.module_log_subdir),
    supervisor_host: config.supervisor_host,
    supervisor_port: config.supervisor_port,
    supervisor_public_key_path: config.supervisor_public_key_path
  });
}

module.exports = {
  MODULE_ACTIONS,
  moduleActions,
  MODULE_KEYS,
  DISPLAY_NAMES,
  LOG_KEYS,
  DEPENDENCIES,
  SUPERVISED_MODULES,
  IN_PROCESS_MODULES,
  CLIENT_APP_MODULES,
  getModuleConfig,
  getAllModuleConfigs,
  isKnownModule,
  getRegistryMetadata,
  getLifecycleActionShape,
  getRuntimeDir,
  classifyRsiModuleStatus
};
