
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enterTrainingRuntimeResourceMode, exitTrainingRuntimeResourceMode } = require('../src/self-improvement/training/runtime-resource-controller.cjs');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-stage6-resource-'));
  const calls = [];
  let owner = 'ollama_cognition';
  const config = { ollama_unload_endpoints: 'http://127.0.0.1:11434', ollama_ps_path: '/api/ps', ollama_unload_path: '/api/generate', ollama_unload_keep_alive_seconds: 0, ollama_unload_timeout_ms: 1000, ollama_reload_timeout_ms: 1000, gpu_owners: 'ollama_cognition|hf_training|hf_rem_inference|vision', gpu_ownership_lock_file: path.join(tmp, 'gpu-owner.json'), model: { name: 'production-cognition-model' } };
  const gpu = {
    currentOwner: () => owner,
    transfer: (from, to) => { assert.equal(from, 'ollama_cognition'); owner = to; calls.push('gpu:' + from + '->' + to); return { owner: to }; },
    acquire: (to) => { owner = to; calls.push('gpu:acquire:' + to); return { owner: to }; },
    assertOwnedBy: (expected) => assert.equal(owner, expected),
    readOwner: () => ({ owner }),
    release: (expected) => { assert.equal(owner, expected); calls.push('gpu:release:' + expected); owner = null; }
  };
  const httpJson = async ({ method, url, body }) => {
    calls.push(method + ':' + url);
    if (url.endsWith('/api/ps')) return { ok: true, status: 200, json: { models: [{ name: 'production-cognition-model' }] } };
    if (body && body.keep_alive === 0) return { ok: true, status: 200, json: { done: true } };
    return { ok: true, status: 200, json: { done: true } };
  };
  const entered = await enterTrainingRuntimeResourceMode({ config, run_id: 'training-test', liveAudio: { setAwake: async (awake) => calls.push('audio:' + awake) }, visionReconciler: { reconcile: async (awake) => calls.push('vision:' + awake) }, knowledgeBootstrap: { stopAndWait: async () => { calls.push('knowledge:stop'); return true; } }, gpu, httpJson, queryGpuComputeProcesses: async () => [] });
  assert.equal(entered.ok, true);
  assert.equal(entered.gpu_owner, 'hf_training');
  assert.deepEqual(calls.slice(0, 3), ['audio:false', 'vision:false', 'knowledge:stop']);
  const exited = await exitTrainingRuntimeResourceMode({ config, gpu, httpJson, applyLifecycle: async () => calls.push('lifecycle:restore'), buildLifecycle: () => ({ is_awake: true }) });
  assert.equal(exited.ok, true);
  assert.equal(owner, null);
  assert(calls.includes('lifecycle:restore'));
  console.log('FLOKI_RSI_TRAINING_RUNTIME_RESOURCE_PRODUCTION_PASS');
})().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
