'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLIENT_APP_KEYS = Object.freeze(['web_app', 'mobile_app']);
const CLIENT_APP_KEY_SET = new Set(CLIENT_APP_KEYS);
const DEFAULT_HEARTBEAT_FRESH_MS = 15000;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const TRANSPORT_RE = /^[a-z][a-z0-9_.:-]{1,64}$/;

function nowIso() {
  return new Date().toISOString();
}

function controlFile(runtimeDir) {
  return path.join(path.resolve(runtimeDir), 'client-app-control.json');
}

function emptyAppState(key) {
  return Object.freeze({
    key,
    enabled: true,
    generation: 1,
    updated_at: nowIso(),
    last_action: 'initial',
    clients: Object.freeze({})
  });
}

function defaultState() {
  return Object.freeze({
    schema_version: 'floki-v2-client-app-control-v1',
    apps: Object.freeze(Object.fromEntries(
      CLIENT_APP_KEYS.map((key) => [key, emptyAppState(key)])
    ))
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(raw) {
  const base = cloneJson(defaultState());
  const source = raw && typeof raw === 'object' ? raw : {};
  const apps = source.apps && typeof source.apps === 'object' ? source.apps : {};
  for (const key of CLIENT_APP_KEYS) {
    const app = apps[key] && typeof apps[key] === 'object' ? apps[key] : {};
    base.apps[key] = {
      key,
      enabled: app.enabled !== false,
      generation: Math.max(1, Number.isInteger(Number(app.generation)) ? Number(app.generation) : 1),
      updated_at: typeof app.updated_at === 'string' ? app.updated_at : nowIso(),
      last_action: typeof app.last_action === 'string' ? app.last_action : 'initial',
      clients: app.clients && typeof app.clients === 'object' ? app.clients : {}
    };
  }
  return base;
}

function readState(options = {}) {
  const runtimeDir = options.runtime_dir;
  if (!runtimeDir) throw new Error('runtime_dir is required');
  try {
    return normalizeState(JSON.parse(fs.readFileSync(controlFile(runtimeDir), 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeState(null);
    return normalizeState({
      read_error: error.message
    });
  }
}

function writeState(state, options = {}) {
  const runtimeDir = options.runtime_dir;
  if (!runtimeDir) throw new Error('runtime_dir is required');
  const filePath = controlFile(runtimeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp-' + String(process.pid) + '-' + String(Date.now());
  fs.writeFileSync(temp, JSON.stringify(normalizeState(state), null, 2) + '\n', 'utf8');
  fs.renameSync(temp, filePath);
}

function assertClientAppKey(appKey) {
  const key = String(appKey || '').trim();
  if (!CLIENT_APP_KEY_SET.has(key)) {
    const error = new Error('unknown client app key');
    error.httpStatus = 400;
    throw error;
  }
  return key;
}

function validateClientId(clientId) {
  const value = String(clientId || '').trim();
  if (!CLIENT_ID_RE.test(value)) {
    const error = new Error('invalid client id');
    error.httpStatus = 400;
    throw error;
  }
  return value;
}

function validateTransport(value) {
  const transport = String(value || 'http').trim().toLowerCase();
  if (!TRANSPORT_RE.test(transport)) {
    const error = new Error('invalid client app transport');
    error.httpStatus = 400;
    throw error;
  }
  return transport;
}

function summarizeAppState(key, appState, options = {}) {
  const nowMs = Number(options.now_ms || Date.now());
  const freshMs = Math.max(1000, Number(options.heartbeat_fresh_ms || DEFAULT_HEARTBEAT_FRESH_MS));
  const clients = appState.clients && typeof appState.clients === 'object' ? appState.clients : {};
  const currentClients = Object.values(clients)
    .filter((client) => client && Number(client.generation) === Number(appState.generation));
  const freshClients = currentClients.filter((client) => {
    const seenAt = Date.parse(String(client.last_heartbeat_at || ''));
    return Number.isFinite(seenAt) && nowMs - seenAt <= freshMs;
  });
  const healthyClients = freshClients.filter((client) => (
    client.healthy === true &&
    !client.last_reported_error
  ));
  const lastClient = currentClients
    .slice()
    .sort((a, b) => Date.parse(String(b.last_heartbeat_at || '')) - Date.parse(String(a.last_heartbeat_at || '')))[0] || null;
  const staleOrErrored = currentClients.some((client) => {
    const seenAt = Date.parse(String(client.last_heartbeat_at || ''));
    return !Number.isFinite(seenAt) ||
      nowMs - seenAt > freshMs ||
      client.healthy !== true ||
      Boolean(client.last_reported_error);
  });
  const status = appState.enabled === false
    ? 'stopped'
    : healthyClients.length > 0 && !staleOrErrored
      ? 'running'
      : 'degraded';
  const connectedSince = healthyClients
    .map((client) => client.connected_since)
    .filter(Boolean)
    .sort()[0] || null;
  const connectedSinceMs = connectedSince ? Date.parse(connectedSince) : NaN;

  return Object.freeze({
    app_key: key,
    enabled: appState.enabled === true,
    status,
    connected_client_count: appState.enabled === true ? freshClients.length : 0,
    healthy_client_count: appState.enabled === true ? healthyClients.length : 0,
    last_heartbeat_at: lastClient ? lastClient.last_heartbeat_at : null,
    connected_since: appState.enabled === true ? connectedSince : null,
    session_uptime_ms: appState.enabled === true && Number.isFinite(connectedSinceMs)
      ? Math.max(0, nowMs - connectedSinceMs)
      : 0,
    transport_type: lastClient ? lastClient.transport_type : null,
    last_reported_error: lastClient ? lastClient.last_reported_error || null : null,
    control_generation: Number(appState.generation) || 1,
    heartbeat_fresh_ms: freshMs,
    stale_client_count: appState.enabled === true
      ? Math.max(0, currentClients.length - freshClients.length)
      : 0,
    clients: Object.freeze(freshClients.map((client) => Object.freeze({
      client_id: client.client_id,
      session_id: client.session_id,
      healthy: client.healthy === true,
      last_heartbeat_at: client.last_heartbeat_at,
      connected_since: client.connected_since,
      transport_type: client.transport_type,
      generation: Number(client.generation)
    })))
  });
}

function readClientAppStatus(appKey, options = {}) {
  const key = assertClientAppKey(appKey);
  const state = readState(options);
  return summarizeAppState(key, state.apps[key], options);
}

function readAllClientAppStatuses(options = {}) {
  const state = readState(options);
  return Object.freeze(Object.fromEntries(
    CLIENT_APP_KEYS.map((key) => [key, summarizeAppState(key, state.apps[key], options)])
  ));
}

function recordClientAppHeartbeat(payload = {}, options = {}) {
  const key = assertClientAppKey(payload.app_key);
  const clientId = validateClientId(payload.client_id);
  const sessionId = payload.session_id == null
    ? clientId
    : validateClientId(payload.session_id);
  const transportType = validateTransport(payload.transport_type || payload.transport || 'http');
  const state = readState(options);
  const app = state.apps[key];
  const at = nowIso();
  const previous = app.clients[clientId] || {};
  const generation = Number(app.generation) || 1;
  const nextApp = {
    ...app,
    updated_at: at,
    clients: {
      ...app.clients,
      [clientId]: {
        client_id: clientId,
        session_id: sessionId,
        generation,
        healthy: payload.healthy !== false && !payload.error,
        last_heartbeat_at: at,
        connected_since: previous.connected_since && Number(previous.generation) === generation
          ? previous.connected_since
          : at,
        transport_type: transportType,
        last_reported_error: payload.error ? String(payload.error).slice(0, 500) : null
      }
    }
  };
  const next = {
    ...state,
    apps: {
      ...state.apps,
      [key]: nextApp
    }
  };
  writeState(next, options);
  return summarizeAppState(key, nextApp, options);
}

function controlClientApp(appKey, action, options = {}) {
  const key = assertClientAppKey(appKey);
  const op = String(action || '').trim();
  if (!['start', 'stop', 'reset'].includes(op)) {
    const error = new Error('unknown client app action');
    error.httpStatus = 400;
    throw error;
  }
  const state = readState(options);
  const before = state.apps[key];
  const previousStatus = summarizeAppState(key, before, options).status;
  const at = nowIso();
  const desiredEnabled = op !== 'stop';
  const nextGeneration = op === 'reset'
    ? Number(before.generation || 1) + 1
    : Number(before.generation || 1);
  const nextApp = {
    ...before,
    enabled: desiredEnabled,
    generation: nextGeneration,
    updated_at: at,
    last_action: op,
    clients: op === 'reset' || op === 'stop' ? {} : before.clients
  };
  const next = {
    ...state,
    apps: {
      ...state.apps,
      [key]: nextApp
    }
  };
  writeState(next, options);
  const current = summarizeAppState(key, nextApp, options);
  return Object.freeze({
    previousStatus,
    current,
    changed: op === 'reset' ||
      before.enabled !== nextApp.enabled ||
      Number(before.generation) !== Number(nextApp.generation)
  });
}

module.exports = {
  CLIENT_APP_KEYS,
  DEFAULT_HEARTBEAT_FRESH_MS,
  controlClientApp,
  controlFile,
  readAllClientAppStatuses,
  readClientAppStatus,
  recordClientAppHeartbeat
};
