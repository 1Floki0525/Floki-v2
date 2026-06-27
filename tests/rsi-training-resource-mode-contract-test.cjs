'use strict';

// Contract: training resource mode acquires the GPU, suspends the configured
// foreground/sensory/GPU workers (never the keep-alive infrastructure), unloads
// Ollama, and verifies GPU ownership — in that order. An Ollama unload failure
// aborts entry and rolls back. Exit restores GPU/container/workers/Ollama and
// surfaces (does not swallow) restoration failures. Boundary-double controllers
// over the real state machine.

const assert = require('node:assert/strict');

const rm = require('../src/self-improvement/training/resource-mode.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
const suspendList = config.training_suspend_workers.split('|');
const keepAlive = config.training_keep_alive_workers.split('|');

function recordingControllers(overrides = {}) {
  const order = [];
  const base = {
    order,
    acquireGpu: async () => { order.push('acquireGpu'); return { owner: 'hf_training' }; },
    suspendWorker: async (w) => { order.push('suspend:' + w); },
    unloadOllama: async () => { order.push('unloadOllama'); return { ok: true, unloaded: [{ model: 'loaded-model-prod' }] }; },
    verifyGpuForTraining: async () => { order.push('verifyGpu'); },
    releaseGpu: async () => { order.push('releaseGpu'); },
    cleanContainer: async () => { order.push('cleanContainer'); },
    restoreWorker: async (w) => { order.push('restore:' + w); },
    reloadOllama: async () => { order.push('reloadOllama'); return { ok: true }; },
    verifyRuntimeReady: async () => { order.push('verifyReady'); }
  };
  return Object.assign(base, overrides);
}

async function main() {
  // --- enter: correct ordering + all suspend-list workers suspended ---
  const c = recordingControllers();
  const entered = await rm.enterTrainingResourceMode({ config, controllers: c, run_id: 'rsi-train-1' });
  assert.equal(entered.entered, true);
  assert.equal(entered.state, rm.STATES.TRAINING_ACTIVE);
  assert.equal(entered.gpu_owner, 'hf_training');
  assert.deepEqual(entered.suspended, suspendList, 'all configured workers suspended');

  // keep-alive infrastructure must NEVER be suspended
  for (const k of keepAlive) {
    assert.ok(!entered.suspended.includes(k), 'keep-alive not suspended: ' + k);
    assert.ok(!c.order.includes('suspend:' + k), 'keep-alive worker was never suspended: ' + k);
  }

  // ordering: GPU acquired, then suspensions, then unload, then verify
  const acquireIdx = c.order.indexOf('acquireGpu');
  const unloadIdx = c.order.indexOf('unloadOllama');
  const verifyIdx = c.order.indexOf('verifyGpu');
  const firstSuspend = c.order.findIndex((s) => s.startsWith('suspend:'));
  assert.ok(acquireIdx < firstSuspend, 'GPU acquired before suspensions');
  assert.ok(firstSuspend < unloadIdx, 'workers suspended before Ollama unload');
  assert.ok(unloadIdx < verifyIdx, 'Ollama unloaded before final GPU verify');

  // --- Ollama unload failure aborts entry and rolls back ---
  const failing = recordingControllers({
    unloadOllama: async () => ({ ok: false, failures: [{ model: 'stuck', error: 'gpu busy' }] })
  });
  let threw = null;
  try {
    await rm.enterTrainingResourceMode({ config, controllers: failing, run_id: 'rsi-train-2' });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'entry aborted on unload failure');
  assert.ok(/Ollama unload failed/.test(threw.message));
  // rollback restored suspended workers + released GPU
  assert.ok(failing.order.includes('releaseGpu'), 'GPU released on rollback');
  assert.ok(failing.order.some((s) => s.startsWith('restore:')), 'workers restored on rollback');

  // --- exit: restores everything, ok when all succeed ---
  const c2 = recordingControllers();
  const exited = await rm.exitTrainingResourceMode({ config, controllers: c2, reason: 'training_complete' });
  assert.equal(exited.ok, true);
  assert.equal(exited.released_gpu, true);
  assert.equal(exited.cleaned_container, true);
  assert.deepEqual(exited.restored, suspendList, 'all workers restored');
  assert.equal(exited.restoration_failures.length, 0);

  // --- exit: restoration failure is surfaced, not swallowed ---
  const c3 = recordingControllers({
    reloadOllama: async () => { throw new Error('ollama did not come back'); },
    verifyRuntimeReady: async () => { throw new Error('runtime not ready'); }
  });
  const exitedBad = await rm.exitTrainingResourceMode({ config, controllers: c3, reason: 'abort' });
  assert.equal(exitedBad.ok, false, 'restoration failure surfaced');
  assert.equal(exitedBad.state, rm.STATES.FAILED);
  const steps = exitedBad.restoration_failures.map((f) => f.step);
  assert.ok(steps.includes('reload_ollama'), 'reload failure recorded');
  assert.ok(steps.includes('verify_ready'), 'verify failure recorded');
  // even with failures, GPU release/container clean/worker restore were attempted
  assert.equal(exitedBad.released_gpu, true);

  console.log(JSON.stringify({
    marker: 'FLOKI_V2_RSI_TRAINING_RESOURCE_MODE_PASS',
    enter_ordering_correct: true,
    keep_alive_never_suspended: true,
    unload_failure_aborts_and_rolls_back: true,
    exit_restores_everything: true,
    restoration_failure_surfaced: true
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
