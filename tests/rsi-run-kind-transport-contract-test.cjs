'use strict';

// Contract: run kinds (code/training) flow through the backend transport. The
// run-kind model maps to candidate types, the sandbox agent config carries the
// kind to the container, status records it, runNow validates the kind early, and
// the code-patch promoter refuses training (model_adapter) candidates. Real fns.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runKinds = require('../src/self-improvement/run-kinds.cjs');
const sandbox = require('../src/self-improvement/sandbox.cjs');
const store = require('../src/self-improvement/store.cjs');
const promoter = require('../src/self-improvement/promoter.cjs');
const promotion = require('../src/self-improvement/promotion.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();

async function assertRejects(fn, re) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected rejection');
  assert.ok(re.test(threw.message), 'message matched ' + re + ' got: ' + (threw && threw.message));
}

async function main() {
  // --- run-kind model ---
  const kinds = runKinds.loadRunKinds(config);
  assert.ok(kinds.allowed.includes('code') && kinds.allowed.includes('training'), 'code + training allowed');
  assert.equal(kinds.default, 'code');
  assert.equal(runKinds.candidateTypeForKind('code', config), 'code_patch');
  assert.equal(runKinds.candidateTypeForKind('training', config), 'model_adapter');
  assert.equal(runKinds.isTrainingKind('training', config), true);
  assert.equal(runKinds.isTrainingKind('code', config), false);
  assert.equal(runKinds.normalizeRunKind('', config), 'code', 'empty kind => default');
  assert.throws(() => runKinds.normalizeRunKind('bogus', config), /unknown RSI run kind/);

  // --- defaultStatus carries the run-kind fields ---
  const ds = store.defaultStatus(config);
  assert.ok('current_run_kind' in ds && 'current_candidate_type' in ds, 'status has run-kind fields');
  assert.equal(ds.current_run_kind, 'code');

  // --- sandbox agent config carries the kind to the container ---
  const snap = { run_id: 'rsi-x', run_root: '/tmp/x', repo_dir: '/tmp/x/repo', self_context_dir: '/tmp/x/sc' };
  const codeCfg = sandbox.agentConfig(snap, { objective: '', kind: 'code' }, config);
  assert.equal(codeCfg.run_kind, 'code');
  assert.equal(codeCfg.candidate_type, 'code_patch');
  const trainCfg = sandbox.agentConfig(snap, { objective: '', kind: 'training' }, config);
  assert.equal(trainCfg.run_kind, 'training');
  assert.equal(trainCfg.candidate_type, 'model_adapter');

  // --- code-patch promoter refuses training (model_adapter) candidates ---
  const codeCandidate = { candidate_type: 'code_patch', changed_files: ['src/x.cjs'], diff: 'diff', before_hashes: {} };
  promoter.validateCandidatePolicy(codeCandidate, config); // type gate accepts code_patch
  const adapterCandidate = { candidate_type: 'model_adapter', changed_files: ['adapter/x'], diff: 'diff', before_hashes: {} };
  assert.throws(() => promoter.validateCandidatePolicy(adapterCandidate, config), /refuses candidate type/);

  // --- runNow validates the kind early (before any worker interaction) ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-kind-'));
  const isoConfig = Object.assign({}, config, {
    runtime_root: path.join(tmp, 'runtime'),
    candidate_root: path.join(tmp, 'candidates'),
    outbox_root: path.join(tmp, 'outbox'),
    workspace_root: path.join(tmp, 'workspaces'),
    model_proxy_root: path.join(tmp, 'model-proxy')
  });
  try {
    const token = store.ensureApprovalToken(isoConfig);
    await assertRejects(() => promotion.runNow(token, 'x', 'bogus', isoConfig), /unknown RSI run kind/);
    // a valid kind passes validation and reaches the worker gate (no worker => rejected there)
    await assertRejects(
      () => promotion.runNow(token, 'x', 'training', isoConfig),
      /worker is not running|not ready|already active/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    marker: 'FLOKI_V2_RSI_RUN_KIND_TRANSPORT_PASS',
    kinds: kinds.allowed,
    candidate_types: kinds.candidate_types,
    agent_config_carries_kind: true,
    promoter_refuses_model_adapter: true,
    run_now_validates_kind: true
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
