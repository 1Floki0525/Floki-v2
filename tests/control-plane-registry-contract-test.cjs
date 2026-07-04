'use strict';

/**
 * Control-plane registry contract test.
 *
 * Proves the authoritative module registry exposes the required stable keys,
 * immutable records, lifecycle metadata, and security properties expected by
 * all clients (status, lifecycle control, logs, Electron, web, Android).
 */

const assert = require('node:assert/strict');

const {
  MODULE_KEYS,
  DISPLAY_NAMES,
  LOG_KEYS,
  DEPENDENCIES,
  SUPERVISED_MODULES,
  IN_PROCESS_MODULES,
  classifyRsiModuleStatus,
  getModuleConfig,
  isKnownModule,
  getRegistryMetadata
} = require('../src/control-plane/module-registry.cjs');
const { createChatLocalInterfaceApi } = require('../src/runtime/chat-local-interface-api.cjs');

function run() {
  // 1. Keys are exactly the 14 visible modules.
  assert.deepEqual(MODULE_KEYS, [
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

  // 2. Every registry module has required fields and functions.
  for (const key of MODULE_KEYS) {
    const config = getModuleConfig(key);
    assert.equal(config.key, key);
    assert.equal(typeof config.name, 'string');
    assert.equal(typeof config.status_source, 'function');
    assert.equal(typeof config.start, 'object');
    assert.equal(typeof config.stop, 'object');
    assert.equal(typeof config.reset, 'object');
    assert.equal(typeof config.health, 'object');
    assert.ok(Array.isArray(config.dependencies));
    assert.equal(typeof config.log_source, 'object');
    assert.equal(typeof config.client_app, 'boolean');
    assert.equal(typeof config.log_available, 'boolean');
    assert.equal(typeof config.log_key, 'string');
    assert.ok(config.log_key.length > 0, 'logKey must be non-empty');
    assert.equal(config.log_available, true);
    assert.equal(typeof config.timeout_ms, 'number');
    assert.equal(typeof config.requires_confirmation, 'boolean');
    assert.equal(typeof config.preserve_runtime_pid, 'boolean');
    assert.equal(typeof config.supervised, 'boolean');
    assert.equal(typeof config.in_process, 'boolean');
  }

  // 3. All cards returned by buildServices satisfy the new public contract.
  const interfaceApi = createChatLocalInterfaceApi({ runtime_dir: undefined });
  const cards = interfaceApi.buildServices();
  assert.equal(cards.length, 14);
  for (const card of cards) {
    assert.equal(typeof card.key, 'string');
    assert.equal(typeof card.name, 'string');
    assert.equal(typeof card.status, 'string');
    assert.equal(typeof card.lifecycleState, 'string');
    assert.equal(card.startAvailable, true);
    assert.equal(card.stopAvailable, true);
    assert.equal(card.resetAvailable, true);
    assert.equal(typeof card.clientApp, 'boolean');
    if (card.clientApp) {
      assert.equal(card.logAvailable, true);
      assert.ok(card.logKey.length > 0, 'client app logKey must be non-empty');
      assert.equal(typeof card.enabled, 'boolean');
      assert.equal(typeof card.connectedClientCount, 'number');
      assert.equal(typeof card.healthyClientCount, 'number');
      assert.equal(typeof card.controlGeneration, 'number');
    } else {
      assert.equal(card.logAvailable, true);
      assert.ok(card.logKey.length > 0, 'logKey must be non-empty');
    }
    assert.equal(typeof card.requiresConfirmation, 'boolean');
    assert.equal(typeof card.dependencyWarning, 'string');
    assert.equal(typeof card.lastHeartbeat, 'number');
    assert.equal(typeof card.uptime, 'number');
    assert.equal(typeof card.latency, 'number');
    assert.equal(typeof card.detail, 'string');
    assert.equal(typeof card.lastError, 'object');
  }

  const now = Date.parse('2026-07-02T18:00:00.000Z');
  const rsiConfig = { worker_heartbeat_stale_ms: 30000 };
  const rsiStatusSource = getModuleConfig('rsi').status_source;
  const liveIdleWorker = {
    rsiConfig,
    now,
    rsiPidAlive: true,
    rsiStatus: {
      enabled: true,
      worker_running: true,
      worker_pid: 1234,
      worker_alive_at: '2026-07-02T17:59:50.000Z',
      current_run_id: null,
      current_container: null,
      state: 'waiting_for_idle',
      last_error: null
    }
  };
  assert.equal(classifyRsiModuleStatus(liveIdleWorker), 'running');
  assert.equal(rsiStatusSource(liveIdleWorker), 'running');
  assert.equal(rsiStatusSource({
    ...liveIdleWorker,
    rsiStatus: {
      ...liveIdleWorker.rsiStatus,
      current_run_id: 'rsi-test',
      current_container: 'floki-rsi-sandbox',
      state: 'experimenting'
    }
  }), 'running');
  assert.equal(rsiStatusSource({
    rsiConfig,
    now,
    rsiPidAlive: false,
    rsiStatus: {
      enabled: true,
      worker_running: false,
      state: 'waiting_for_idle',
      current_run_id: null,
      current_container: null,
      last_error: null
    }
  }), 'degraded');
  assert.equal(rsiStatusSource({
    rsiConfig,
    now,
    rsiPidAlive: false,
    rsiStatus: { enabled: false, worker_running: false, state: 'disabled' }
  }), 'stopped');
  assert.equal(rsiStatusSource({
    ...liveIdleWorker,
    rsiStatus: {
      ...liveIdleWorker.rsiStatus,
      worker_alive_at: '2026-07-02T17:00:00.000Z'
    }
  }), 'degraded');
  assert.equal(rsiStatusSource({
    ...liveIdleWorker,
    rsiStatus: {
      ...liveIdleWorker.rsiStatus,
      last_error: 'worker heartbeat unreadable'
    }
  }), 'degraded');

  const hearingStatusSource = getModuleConfig('hearing').status_source;
  assert.equal(hearingStatusSource({
    currentStatus: {
      hearing_enabled: true,
      lifecycle: { is_awake: true },
      hearing_ready: true,
      hearing: { service_state: 'listening' }
    },
    hearingError: null
  }), 'running');
  assert.equal(hearingStatusSource({
    currentStatus: {
      hearing_enabled: true,
      lifecycle: { is_awake: true },
      hearing_ready: false,
      hearing: { service_state: 'starting' }
    },
    hearingError: null
  }), 'degraded');
  assert.equal(hearingStatusSource({
    currentStatus: {
      hearing_enabled: true,
      lifecycle: { is_awake: false },
      hearing_ready: true,
      hearing: { service_state: 'listening' }
    },
    hearingError: null
  }), 'stopped');

  const schedulerStatusSource = getModuleConfig('sleep_scheduler').status_source;
  assert.equal(schedulerStatusSource({ schedulerPid: process.pid }), 'running');
  assert.equal(schedulerStatusSource({ schedulerPid: null }), 'stopped');

  // 4. No module accepts shell/executable/path/argument/env input from clients.
  for (const key of MODULE_KEYS) {
    const config = getModuleConfig(key);
    assert.strictEqual(config.start.internal, true);
    assert.strictEqual(config.stop.internal, true);
    assert.strictEqual(config.reset.internal, true);
    assert.strictEqual(config.health.internal, true);
    assert.strictEqual(config.start.script, undefined);
    assert.strictEqual(config.start.command, undefined);
    assert.strictEqual(config.start.executable, undefined);
    assert.strictEqual(config.start.path, undefined);
    assert.strictEqual(config.start.args, undefined);
    assert.strictEqual(config.start.env, undefined);
    assert.strictEqual(config.start.systemd_unit, undefined);
    assert.strictEqual(config.stop.script, undefined);
    assert.strictEqual(config.stop.command, undefined);
    assert.strictEqual(config.stop.systemd_unit, undefined);
  }

  // 5. Runtime PID preservation is correct per module.
  assert.equal(getModuleConfig('floki_core').preserve_runtime_pid, false);
  for (const key of MODULE_KEYS) {
    if (key === 'floki_core') continue;
    assert.equal(getModuleConfig(key).preserve_runtime_pid, true, key + ' must preserve runtime PID');
  }

  // 6. Log keys are unique.
  const logKeys = new Set();
  for (const key of MODULE_KEYS) {
    const logKey = LOG_KEYS[key];
    assert.ok(logKey, 'log key missing for ' + key);
    assert.equal(logKeys.has(logKey), false, 'duplicate log key: ' + logKey);
    logKeys.add(logKey);
  }

  // 7. Confirmation requirement is scoped to floki_core and authoritative_api stop.
  for (const key of MODULE_KEYS) {
    const config = getModuleConfig(key);
    const expected = key === 'floki_core' || key === 'authoritative_api';
    assert.equal(config.requires_confirmation, expected, key + ' confirmation requirement mismatch');
  }

  // 8. Supervised / in-process partition covers all 14 modules without overlap.
  for (const key of MODULE_KEYS) {
    const config = getModuleConfig(key);
    assert.equal(config.supervised || config.in_process, true, key + ' must be supervised or in-process');
    assert.equal(config.supervised && config.in_process, false, key + ' cannot be both supervised and in-process');
  }
  assert.deepEqual(Array.from(SUPERVISED_MODULES).sort(), [
    'authoritative_api',
    'floki_core',
    'rsi',
    'sleep_scheduler',
    'vision'
  ]);
  assert.deepEqual(Array.from(IN_PROCESS_MODULES).sort(), [
    'cognition',
    'dream_engine',
    'emotion',
    'hearing',
    'live_event_stream',
    'memory',
    'mobile_app',
    'speech',
    'web_app'
  ]);
  assert.equal(getModuleConfig('web_app').client_app, true);
  assert.equal(getModuleConfig('mobile_app').client_app, true);
  for (const key of MODULE_KEYS) {
    if (key === 'web_app' || key === 'mobile_app') continue;
    assert.equal(getModuleConfig(key).client_app, false, key + ' must not be a client-app module');
  }

  // 9. Registry metadata is immutable-ish (frozen) and complete.
  const meta = getRegistryMetadata();
  assert.equal(meta.schema_version, 'floki-v2-module-registry-v1');
  assert.equal(meta.keys.length, 14);
  assert.equal(meta.modules.length, 14);
  assert.equal(meta.actions.allowed_actions.length, 3);
  assert.equal(meta.supervisor_host, '127.0.0.1');
  assert.equal(typeof meta.supervisor_port, 'number');
  assert.equal(typeof meta.supervisor_public_key_path, 'string');

  // 10. isKnownModule allowlists only the 14 keys.
  for (const key of MODULE_KEYS) {
    assert.equal(isKnownModule(key), true);
  }
  assert.equal(isKnownModule('unknown_module'), false);
  assert.equal(isKnownModule(''), false);
  assert.equal(isKnownModule(null), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CONTROL_PLANE_REGISTRY_CONTRACT_PASS',
    keys: MODULE_KEYS,
    card_count: cards.length,
    supervised: Array.from(SUPERVISED_MODULES).sort(),
    in_process: Array.from(IN_PROCESS_MODULES).sort()
  }, null, 2));
}

run();
