'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-finalization-resume-'));
const runtimeRoot = path.join(root, 'runtime');
const adapterRoot = path.join(root, 'adapters');
const candidateRoot = path.join(root, 'candidates');
const sessionFileName = 'nightly-session.json';
const sourceAdapter = path.join(runtimeRoot, 'run-1', 'adapter-output');
fs.mkdirSync(sourceAdapter, { recursive: true });
fs.writeFileSync(
  path.join(sourceAdapter, 'metrics.json'),
  JSON.stringify({ epoch: 1, global_step: 3, train_loss: 1.2 }) + '\n'
);
fs.writeFileSync(path.join(sourceAdapter, 'adapter_config.json'), '{}\n');
fs.writeFileSync(path.join(sourceAdapter, 'adapter_model.safetensors'), 'adapter\n');

// Contract updated 2026-07-04: the nightly completion gate now requires one
// complete REM claim per completed epoch before a candidate may be compiled,
// so the fixture provides the epoch's completed REM claim.
const remClaimFile = path.join(root, 'rem-claims.json');
fs.writeFileSync(remClaimFile, JSON.stringify({
  claims: {
    'run-1-epoch-1': {
      sleep_date: '2026-06-27',
      status: 'complete',
      result: { ok: true }
    }
  }
}) + '\n');

const config = {
  training_runtime_root: runtimeRoot,
  nightly_training_session_file_name: sessionFileName,
  training_metrics_file_name: 'metrics.json',
  nightly_training_min_completed_steps: 1,
  training_rem_claim_file: remClaimFile,
  adapter_root: adapterRoot,
  candidate_root: candidateRoot,
  nightly_training_candidate_objective: 'configured objective',
  dataset_hash_algorithm: 'sha256',
  adapter_id_prefix: 'adapter',
  adapter_version_prefix: 'v',
  adapter_manifest_file_name: 'lineage.json'
};

let persistAttempts = 0;
let candidateWrites = 0;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../config.cjs') {
    return { loadSelfImprovementConfig: () => config };
  }
  if (request === '../store.cjs') {
    return {
      appendAudit() {},
      updateStatus() {},
      nowIso: () => '2026-06-28T00:00:00.000Z',
      paths: () => ({ currentContainerFile: path.join(root, 'current.json') }),
      atomicJson(file, value) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = file + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
        fs.renameSync(temp, file);
      }
    };
  }
  if (request === '../sandbox.cjs') {
    return { waitForContainerStart: async () => {} };
  }
  if (request === './master-preflight.cjs') {
    return { assertHfMasterReady: () => ({ path: '/master' }) };
  }
  if (request === './dataset-builder.cjs') {
    return { buildDataset: () => ({}) };
  }
  if (request === './qlora-config.cjs') {
    return { buildTrainingConfig: () => ({}), buildTrainingRunArgs: () => [] };
  }
  if (request === './lineage.cjs') {
    return {
      nextAdapterVersion: () => ({ version_number: 1, version: 'v1' }),
      createLineageRecord: () => ({
        adapter_id: 'adapter-v1-stable',
        version: 'v1',
        version_number: 1
      }),
      persistLineage(lineage) {
        persistAttempts += 1;
        if (persistAttempts === 1) throw new Error('fixture persist interruption');
        const dir = path.join(adapterRoot, lineage.adapter_id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'lineage.json');
        fs.writeFileSync(file, JSON.stringify(lineage) + '\n');
        return file;
      }
    };
  }
  if (request === './training-runner.cjs') {
    return {
      ensureTrainingImage: () => ({}),
      validateTrainingArtifacts: (dir) => {
        assert.equal(fs.existsSync(dir), true);
        return { metrics: JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'))) };
      },
      writeAdapterCandidate(input) {
        candidateWrites += 1;
        assert.equal(input.lineage.adapter_id, 'adapter-v1-stable');
        return { id: 'adapter-v1-stable' };
      }
    };
  }
  return originalLoad.apply(this, arguments);
};

const {
  finalizeNightlyTraining,
  sessionFile
} = require('../src/self-improvement/training/nightly-training-session.cjs');
Module._load = originalLoad;

const initial = {
  marker: 'FLOKI_V2_NIGHTLY_TRAINING_SESSION',
  run_id: 'run-1',
  sleep_date: '2026-06-27',
  active: true,
  finalized: false,
  training_failed: false,
  current_container: null,
  hf_master: { path: '/master', identity: 'master' },
  dataset: { dataset_id: 'ds-1', records_sha256: 'hash' },
  base_training_config: { training: { seed: 42 } },
  runtime: {
    adapter_output: sourceAdapter,
    training_config_file: path.join(runtimeRoot, 'missing-config.json'),
    control_file: path.join(runtimeRoot, 'control.json'),
    control_response_file: path.join(runtimeRoot, 'control-response.json')
  }
};

assert.throws(
  () => finalizeNightlyTraining(initial, { config }),
  /fixture persist interruption/
);
const persisted = JSON.parse(fs.readFileSync(sessionFile(config), 'utf8'));
assert.equal(persisted.status, 'finalizing');
assert.equal(persisted.finalization_plan.adapter_id, 'adapter-v1-stable');
assert.equal(fs.existsSync(sourceAdapter), false);
assert.equal(fs.existsSync(persisted.finalization_plan.final_adapter_dir), true);

const completed = finalizeNightlyTraining(persisted, { config });
assert.equal(completed.finalized, true);
assert.equal(completed.candidate_id, 'adapter-v1-stable');
assert.equal(completed.adapter_id, 'adapter-v1-stable');
assert.equal(persistAttempts, 2);
assert.equal(candidateWrites, 1);

fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_NIGHTLY_FINALIZATION_RESUME_PASS',
  durable_finalization_plan: true,
  same_adapter_identity_after_retry: true,
  moved_artifacts_reused_after_interruption: true
}, null, 2));
