'use strict';

const assert = require('node:assert/strict');
const {
  enterTrainingRuntimeResourceMode,
  exitTrainingRuntimeResourceMode
} = require('../src/self-improvement/training/runtime-resource-controller.cjs');

function config() {
  return {
    ollama_unload_endpoints: 'http://127.0.0.1:11434',
    ollama_ps_path: '/api/ps',
    ollama_unload_path: '/api/generate',
    ollama_unload_keep_alive_seconds: 0,
    ollama_unload_timeout_ms: 1000,
    ollama_reload_timeout_ms: 1000,
    model: { name: 'configured-model' }
  };
}

function httpJson(calls) {
  return async ({ method, url, body }) => {
    calls.push(method + ':' + url + ':' + String(body && body.keep_alive));
    if (url.endsWith('/api/ps')) {
      return {
        ok: true,
        status: 200,
        json: { models: [{ name: 'configured-model' }] }
      };
    }
    return { ok: true, status: 200, json: { done: true } };
  };
}

(async () => {
  const calls = [];
  let owner = 'ollama_cognition';
  const gpu = {
    currentOwner: () => owner,
    transfer(from, to) {
      assert.equal(from, 'ollama_cognition');
      owner = to;
      calls.push('gpu:' + from + '->' + to);
      return { owner: to };
    },
    acquire(to) { owner = to; return { owner: to }; },
    assertOwnedBy(expected) { assert.equal(owner, expected); },
    readOwner: () => ({ owner }),
    release(expected) {
      assert.equal(owner, expected);
      calls.push('gpu:release:' + expected);
      owner = null;
    }
  };
  const deps = {
    config: config(),
    liveAudio: {
      async setAwake(value) { calls.push('audio:' + value); }
    },
    visionReconciler: {
      async reconcile(value) { calls.push('vision:' + value); }
    },
    knowledgeBootstrap: {
      async stopAndWait() { calls.push('knowledge:stop'); return true; }
    },
    restartKnowledge: async () => {
      calls.push('knowledge:start');
      return { started: true };
    },
    applyLifecycle: async () => { calls.push('lifecycle:restore'); },
    buildLifecycle: () => ({ is_awake: true }),
    httpJson: httpJson(calls),
    gpu,
    queryGpuComputeProcesses: async () => []
  };

  const entered = await enterTrainingRuntimeResourceMode({
    ...deps,
    run_id: 'transaction-success'
  });
  assert.equal(entered.ok, true);
  assert.equal(owner, 'hf_training');
  assert.deepEqual(calls.slice(0, 3), [
    'audio:false',
    'vision:false',
    'knowledge:stop'
  ]);

  const exited = await exitTrainingRuntimeResourceMode({
    ...deps,
    reason: 'test_exit'
  });
  assert.equal(exited.ok, true);
  assert.equal(exited.knowledge_restarted, true);
  assert.equal(exited.lifecycle_restored, true);
  assert.equal(owner, null);
  assert(calls.includes('knowledge:start'));
  assert(calls.includes('lifecycle:restore'));

  const rollbackCalls = [];
  let rollbackOwner = 'ollama_cognition';
  const failingGpu = {
    currentOwner: () => rollbackOwner,
    transfer() { throw new Error('fixture GPU transfer failure'); },
    acquire() { throw new Error('unexpected acquire'); },
    assertOwnedBy() {},
    readOwner: () => ({ owner: rollbackOwner }),
    release() { rollbackOwner = null; }
  };

  await assert.rejects(
    () => enterTrainingRuntimeResourceMode({
      config: config(),
      run_id: 'transaction-rollback',
      liveAudio: {
        async setAwake(value) { rollbackCalls.push('audio:' + value); }
      },
      visionReconciler: {
        async reconcile(value) { rollbackCalls.push('vision:' + value); }
      },
      knowledgeBootstrap: {
        async stopAndWait() { rollbackCalls.push('knowledge:stop'); return true; }
      },
      restartKnowledge: async () => {
        rollbackCalls.push('knowledge:start');
        return { started: true };
      },
      applyLifecycle: async () => { rollbackCalls.push('lifecycle:restore'); },
      buildLifecycle: () => ({ is_awake: true }),
      httpJson: httpJson(rollbackCalls),
      gpu: failingGpu,
      queryGpuComputeProcesses: async () => []
    }),
    (error) => {
      assert.match(error.message, /FLOKI_TRAINING_RESOURCE_ENTER_FAILED/);
      assert.match(error.message, /fixture GPU transfer failure/);
      assert.equal(error.resource_result.rollback.ok, true);
      return true;
    }
  );
  assert(rollbackCalls.includes('knowledge:start'));
  assert(rollbackCalls.includes('lifecycle:restore'));
  assert(rollbackCalls.some((entry) => entry.includes(':-1')));

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_TRAINING_RUNTIME_RESOURCE_TRANSACTION_PASS',
    entry_transactional: true,
    failure_rollback_verified: true,
    knowledge_restart_verified: true,
    lifecycle_restoration_verified: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
