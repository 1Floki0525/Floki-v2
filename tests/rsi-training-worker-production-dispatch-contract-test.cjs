'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const { runCycle } = require('../src/self-improvement/worker.cjs');

(async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-training-dispatch-')
  );
  let called = 0;

  // Use the complete production YAML-derived configuration so every storage
  // filename and runtime limit required by store.cjs is present. Override only
  // the mutable test roots, keeping the behavioral dispatch path identical to
  // production without touching real RSI state.
  const production = loadSelfImprovementConfig();
  const config = Object.freeze({
    ...production,
    workspace_root: path.join(root, 'workspaces'),
    candidate_root: path.join(root, 'candidates'),
    outbox_root: path.join(root, 'outbox'),
    runtime_root: path.join(root, 'runtime'),
    model_proxy_root: path.join(root, 'model-proxy'),
    adapter_root: path.join(root, 'adapters'),
    dataset_root: path.join(root, 'datasets'),
    training_runtime_root: path.join(root, 'training-runtime'),
    gpu_ownership_lock_file: path.join(root, 'gpu-owner.lock'),
    training_rem_claim_file: path.join(root, 'rem-claims.json')
  });

  const result = await runCycle({
    config,
    kind: 'training',
    force: true,
    objective: 'production dispatch proof',
    training_cycle_runner: async (options) => {
      called += 1;
      assert.equal(options.config, config);
      assert.equal(options.kind, 'training');
      assert.equal(options.candidate_type, 'model_adapter');
      assert.equal(options.objective, 'production dispatch proof');
      return {
        ok: true,
        marker: 'FLOKI_RSI_REAL_TRAINING_RUNNER_BOUNDARY'
      };
    }
  });

  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.equal(
    result.marker,
    'FLOKI_RSI_REAL_TRAINING_RUNNER_BOUNDARY'
  );

  console.log(
    'FLOKI_RSI_TRAINING_WORKER_PRODUCTION_DISPATCH_PASS'
  );
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
