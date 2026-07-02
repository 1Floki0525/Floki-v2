'use strict';

// Ollama load/unload control for training resource mode.
//
// Queries every configured Ollama endpoint for loaded models (/api/ps) and
// unloads them through the real Ollama API with keep_alive: 0, recording the
// endpoint, model, request, response, and unload time for each. Unload failures
// are never silently ignored — they are recorded and propagated. The HTTP
// transport is injectable so CI can use a deterministic boundary double while
// the real scheduler/command/record logic executes. All values from chat YAML.

const { loadSelfImprovementConfig } = require('../config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

// Default real transport: JSON over fetch with an abort timeout.
async function defaultHttpJson({ method, url, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function queryLoadedModels(endpoint, options = {}, config = loadSelfImprovementConfig()) {
  const httpJson = options.httpJson || defaultHttpJson;
  const url = endpoint.replace(/\/$/, '') + config.ollama_ps_path;
  const res = await httpJson({ method: 'GET', url, timeoutMs: config.ollama_unload_timeout_ms });
  const models = res && res.json && Array.isArray(res.json.models)
    ? res.json.models.map((m) => m.name || m.model).filter(Boolean)
    : [];
  return { endpoint, url, ok: Boolean(res && res.ok), models, raw: res };
}

async function waitForNoLoadedModels(
  options = {},
  config = loadSelfImprovementConfig()
) {
  const endpoints = splitPipeList(config.ollama_unload_endpoints);
  const timeoutMs = Number(config.ollama_unload_timeout_ms);
  const pollMs = Number(config.nightly_ollama_guard_poll_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      'ollama_unload_timeout_ms must be a non-negative YAML number'
    );
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(
      'nightly_ollama_guard_poll_ms must be a positive YAML number'
    );
  }

  const now = typeof options.now === 'function'
    ? options.now
    : Date.now;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (delayMs) =>
        new Promise((resolve) => setTimeout(resolve, delayMs));

  const deadline = now() + timeoutMs;
  let attempts = 0;
  let remaining = [];

  while (true) {
    attempts += 1;
    remaining = [];

    for (const endpoint of endpoints) {
      const listing = await queryLoadedModels(
        endpoint,
        options,
        config
      );
      if (!listing.ok) {
        throw new Error(
          'configured Ollama residency check failed: ' + endpoint
        );
      }
      for (const model of listing.models) {
        remaining.push({ endpoint, model });
      }
    }

    if (remaining.length === 0) {
      return Object.freeze({
        ok: true,
        attempts,
        remaining: Object.freeze([])
      });
    }

    const delayMs = Math.min(
      pollMs,
      Math.max(0, deadline - now())
    );
    if (delayMs <= 0) {
      return Object.freeze({
        ok: false,
        attempts,
        remaining: Object.freeze(
          remaining.map((entry) => Object.freeze({ ...entry }))
        )
      });
    }

    await sleep(delayMs);
  }
}

async function unloadModel(endpoint, model, options = {}, config = loadSelfImprovementConfig()) {
  const httpJson = options.httpJson || defaultHttpJson;
  const url = endpoint.replace(/\/$/, '') + config.ollama_unload_path;
  const request = { model, keep_alive: config.ollama_unload_keep_alive_seconds };
  const startedAt = Date.now();
  let response = null;
  let error = null;
  try {
    response = await httpJson({ method: 'POST', url, body: request, timeoutMs: config.ollama_unload_timeout_ms });
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  const unloadMs = Date.now() - startedAt;
  const ok = Boolean(response && response.ok) && !error;
  return {
    endpoint,
    url,
    model,
    request,
    response: response ? { status: response.status, json: response.json } : null,
    unload_ms: unloadMs,
    ok,
    error
  };
}

// Unload all loaded models across every configured endpoint. Returns ok=false if
// ANY query/unload failed, with the failures recorded (never swallowed).
async function unloadAllLoaded(options = {}, config = loadSelfImprovementConfig()) {
  const endpoints = splitPipeList(config.ollama_unload_endpoints).length
    ? splitPipeList(config.ollama_unload_endpoints)
    : config.ollama_unload_endpoints.split(',').map((s) => s.trim()).filter(Boolean);
  const records = [];
  const failures = [];

  for (const endpoint of endpoints) {
    let listing;
    try {
      listing = await queryLoadedModels(endpoint, options, config);
    } catch (err) {
      const f = { endpoint, stage: 'query', error: err && err.message ? err.message : String(err) };
      failures.push(f);
      records.push(f);
      continue;
    }
    if (!listing.ok) {
      const f = { endpoint, stage: 'query', error: 'ps query failed', status: listing.raw ? listing.raw.status : null };
      failures.push(f);
      records.push(f);
      continue;
    }
    for (const model of listing.models) {
      const rec = await unloadModel(endpoint, model, options, config);
      records.push(rec);
      if (!rec.ok) failures.push(rec);
    }
  }

  return {
    marker: 'FLOKI_V2_OLLAMA_UNLOAD',
    ok: failures.length === 0,
    endpoints,
    unloaded: records.filter((r) => r.model && r.ok).map((r) => ({ endpoint: r.endpoint, model: r.model, unload_ms: r.unload_ms })),
    records,
    failures
  };
}

// Reload (warm) an approved model on an endpoint (keep_alive default by omission).
async function reloadModel(endpoint, model, options = {}, config = loadSelfImprovementConfig()) {
  const httpJson = options.httpJson || defaultHttpJson;
  const url = endpoint.replace(/\/$/, '') + config.ollama_unload_path;
  const request = { model, prompt: '', keep_alive: -1 };
  const startedAt = Date.now();
  let response = null;
  let error = null;
  try {
    response = await httpJson({ method: 'POST', url, body: request, timeoutMs: config.ollama_reload_timeout_ms });
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  return {
    endpoint,
    url,
    model,
    request,
    response: response ? { status: response.status, json: response.json } : null,
    reload_ms: Date.now() - startedAt,
    ok: Boolean(response && response.ok) && !error,
    error
  };
}

module.exports = {
  defaultHttpJson,
  queryLoadedModels,
  unloadModel,
  unloadAllLoaded,
  waitForNoLoadedModels,
  reloadModel,
  splitPipeList
};
