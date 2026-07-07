'use strict';

// Contract: Ollama control discovers loaded models via /api/ps and unloads them
// with keep_alive: 0, recording endpoint/model/request/response/time. Unload
// failures are recorded and propagated (never swallowed). Uses a deterministic
// HTTP boundary double over the real scheduler/record logic.

const assert = require('node:assert/strict');

const ollama = require('../src/self-improvement/training/ollama-control.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();

async function main() {
  // --- happy path: two loaded models discovered and unloaded ---
  const calls = [];
  const httpJson = async ({ method, url, body }) => {
    calls.push({ method, url, body });
    if (url.endsWith(base.ollama_ps_path)) {
      return { ok: true, status: 200, json: { models: [{ name: 'loaded-model-prod' }, { model: 'embed:small' }] } };
    }
    if (url.endsWith(base.ollama_unload_path)) {
      return { ok: true, status: 200, json: { done: true } };
    }
    return { ok: false, status: 404, json: null };
  };

  const config = Object.assign({}, base, { ollama_unload_endpoints: 'http://127.0.0.1:11434' });
  const result = await ollama.unloadAllLoaded({ httpJson }, config);
  assert.equal(result.marker, 'FLOKI_V2_OLLAMA_UNLOAD');
  assert.equal(result.ok, true, 'all unloads succeeded');
  assert.equal(result.unloaded.length, 2, 'two models unloaded');

  // keep_alive: 0 used in every unload request, recorded fully
  const unloadRecords = result.records.filter((r) => r.model);
  for (const rec of unloadRecords) {
    assert.equal(rec.request.keep_alive, config.ollama_unload_keep_alive_seconds, 'keep_alive from YAML (0)');
    assert.equal(rec.request.keep_alive, 0);
    assert.ok(rec.endpoint && rec.model && rec.request && rec.response, 'full record kept');
    assert.equal(typeof rec.unload_ms, 'number');
  }
  // the ps query happened before unloads
  assert.ok(calls[0].url.endsWith(base.ollama_ps_path), 'discovery via /api/ps first');

  // --- failure propagation: an endpoint whose unload fails => ok false, recorded ---
  const failingHttp = async ({ url }) => {
    if (url.endsWith(base.ollama_ps_path)) {
      return { ok: true, status: 200, json: { models: [{ name: 'stuck-model' }] } };
    }
    return { ok: false, status: 500, json: { error: 'gpu busy' } };
  };
  const failResult = await ollama.unloadAllLoaded({ httpJson: failingHttp }, config);
  assert.equal(failResult.ok, false, 'unload failure propagates');
  assert.ok(failResult.failures.length >= 1, 'failure recorded, not swallowed');
  assert.equal(failResult.failures[0].model, 'stuck-model');

  // --- ps query failure also propagates ---
  const psFailHttp = async () => ({ ok: false, status: 503, json: null });
  const psFail = await ollama.unloadAllLoaded({ httpJson: psFailHttp }, config);
  assert.equal(psFail.ok, false);
  assert.equal(psFail.failures[0].stage, 'query');

  // --- reload uses keep_alive to warm the approved model ---
  const reload = await ollama.reloadModel('http://127.0.0.1:11434', 'loaded-model-prod', { httpJson }, config);
  assert.equal(reload.ok, true);
  assert.equal(reload.model, 'loaded-model-prod');

  console.log(JSON.stringify({
    marker: 'FLOKI_V2_RSI_OLLAMA_UNLOAD_PASS',
    discovery_via_ps: true,
    keep_alive_zero: true,
    full_records: true,
    failure_propagated: true,
    reload_supported: true
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
