'use strict';

const assert = require('node:assert/strict');
const {
  enterTrainingRuntimeResourceMode,
  exitTrainingRuntimeResourceMode
} = require('../src/self-improvement/training/runtime-resource-controller.cjs');

function fixtureConfig() {
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

function transport() {
  let loaded = true;
  return async ({ url, body }) => {
    if (url.endsWith('/api/ps')) {
      return {
        ok: true,
        status: 200,
        json: {
          models: loaded ? [{ name: 'configured-model' }] : []
        }
      };
    }
    if (body && body.keep_alive === 0) loaded = false;
    if (body && body.keep_alive === -1) loaded = true;
    return {
      ok: true,
      status: 200,
      json: { done: true, body: body || null }
    };
  };
}

(async () => {
  let owner = 'ollama_cognition';
  const gpu = {
    currentOwner: () => owner,
    transfer(from, to) {
      assert.equal(from, 'ollama_cognition');
      owner = to;
      return { owner: to };
    },
    acquire(to) {
      owner = to;
      return { owner: to };
    },
    assertOwnedBy(expected) {
      assert.equal(owner, expected);
    },
    readOwner: () => ({ owner }),
    release(expected) {
      assert.equal(owner, expected);
      owner = null;
    }
  };

  const entered = await enterTrainingRuntimeResourceMode({
    config: fixtureConfig(),
    run_id: 'legacy-production-contract',
    liveAudio: { setAwake: async () => undefined },
    visionReconciler: { reconcile: async () => undefined },
    knowledgeBootstrap: { stopAndWait: async () => true },
    gpu,
    httpJson: transport(),
    queryGpuComputeProcesses: async () => []
  });
  assert.equal(entered.ok, true);
  assert.equal(owner, 'hf_training');

  const exited = await exitTrainingRuntimeResourceMode({
    config: fixtureConfig(),
    gpu,
    httpJson: transport(),
    applyLifecycle: async () => undefined,
    buildLifecycle: () => ({ is_awake: true }),
    // Deterministic daytime semantics regardless of when the test runs.
    is_within_sleep_window: () => false
  });
  assert.equal(exited.ok, true);
  assert.equal(exited.knowledge_restart_required, false);
  assert.equal(exited.knowledge_restart_skipped, true);
  assert.equal(exited.lifecycle_restore_required, true);
  assert.equal(exited.lifecycle_restored, true);
  assert.equal(owner, null);

  owner = 'ollama_cognition';
  const failingGpu = {
    currentOwner: () => owner,
    transfer() {
      throw new Error('fixture transfer failure');
    },
    acquire() {
      throw new Error('unexpected acquire');
    },
    assertOwnedBy() {},
    readOwner: () => ({ owner }),
    release() {
      owner = null;
    }
  };

  await assert.rejects(
    () => enterTrainingRuntimeResourceMode({
      config: fixtureConfig(),
      run_id: 'missing-rollback-dependencies',
      liveAudio: { setAwake: async () => undefined },
      visionReconciler: { reconcile: async () => undefined },
      knowledgeBootstrap: { stopAndWait: async () => true },
      gpu: failingGpu,
      httpJson: transport(),
      queryGpuComputeProcesses: async () => [],
      // Deterministic daytime semantics regardless of when the test runs.
      is_within_sleep_window: () => false
    }),
    (error) => {
      assert.match(
        error.message,
        /FLOKI_TRAINING_RESOURCE_ENTER_FAILED/
      );
      assert.match(error.message, /fixture transfer failure/);
      assert.match(error.message, /missing restartKnowledge/);
      assert.match(error.message, /missing applyLifecycle/);
      assert.equal(error.resource_result.rollback.ok, false);
      assert.equal(
        error.resource_result.rollback.knowledge_restart_required,
        true
      );
      assert.equal(
        error.resource_result.rollback.lifecycle_restore_required,
        true
      );
      return true;
    }
  );

  console.log(JSON.stringify({
    ok: true,
    marker:
      'FLOKI_RSI_TRAINING_RUNTIME_RESOURCE_COMPATIBILITY_PASS',
    successful_entry_defers_restore_dependencies: true,
    legacy_exit_contract_preserved: true,
    missing_rollback_dependencies_surface_failures: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
