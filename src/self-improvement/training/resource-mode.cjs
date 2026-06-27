'use strict';

// Training resource-mode state machine.
//
// When training begins, the host transitions into training resource mode:
//   acquire GPU (hf_training) -> suspend foreground/sensory/GPU workers ->
//   unload Ollama models -> verify GPU ownership -> training_active.
// On completion / cancellation / failure / wake transition it restores:
//   release training GPU -> clean training container -> restore workers ->
//   reload approved Ollama model -> verify readiness.
// Keep-alive infrastructure (Electron app, chat API, status transport, RSI
// worker, sleep scheduler, training supervisor) is NEVER suspended. Unload and
// restoration failures are surfaced, never swallowed. The controllers (GPU,
// Ollama, worker suspend/restore, container cleanup, verification) are injected
// so CI uses deterministic boundary doubles over the real control flow.

const { loadSelfImprovementConfig } = require('../config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

const STATES = Object.freeze({
  IDLE: 'idle',
  ACQUIRING_GPU: 'acquiring_gpu',
  SUSPENDING_WORKERS: 'suspending_workers',
  UNLOADING_OLLAMA: 'unloading_ollama',
  VERIFYING: 'verifying',
  TRAINING_ACTIVE: 'training_active',
  RESTORING: 'restoring',
  FAILED: 'failed'
});

function requireController(controllers, name) {
  if (typeof controllers[name] !== 'function') {
    throw new Error('training resource controller missing: ' + name);
  }
  return controllers[name];
}

async function enterTrainingResourceMode(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const controllers = options.controllers || {};
  const runId = options.run_id || null;

  const suspendList = splitPipeList(config.training_suspend_workers);
  const keepAlive = splitPipeList(config.training_keep_alive_workers);
  // Integrity: a keep-alive worker must never be in the suspend list.
  for (const k of keepAlive) {
    if (suspendList.includes(k)) throw new Error('keep-alive worker is also marked for suspension: ' + k);
  }

  const state = {
    marker: 'FLOKI_V2_TRAINING_RESOURCE_ENTER',
    state: STATES.IDLE,
    run_id: runId,
    gpu_owner: null,
    suspended: [],
    kept_alive: keepAlive,
    ollama_unload: null,
    entered: false
  };

  const acquireGpu = requireController(controllers, 'acquireGpu');
  const suspendWorker = requireController(controllers, 'suspendWorker');
  const unloadOllama = requireController(controllers, 'unloadOllama');
  const verifyGpu = requireController(controllers, 'verifyGpuForTraining');
  const restoreWorker = controllers.restoreWorker;
  const releaseGpu = controllers.releaseGpu;

  // 1) Acquire GPU for training (exclusive).
  state.state = STATES.ACQUIRING_GPU;
  const owner = await acquireGpu({ run_id: runId });
  state.gpu_owner = owner && owner.owner ? owner.owner : 'hf_training';

  // 2) Suspend foreground / sensory / non-training GPU workers.
  state.state = STATES.SUSPENDING_WORKERS;
  for (const worker of suspendList) {
    await suspendWorker(worker);
    state.suspended.push(worker);
  }

  // 3) Unload Ollama models (failures abort training start; never swallowed).
  state.state = STATES.UNLOADING_OLLAMA;
  state.ollama_unload = await unloadOllama();
  if (!state.ollama_unload || state.ollama_unload.ok !== true) {
    // Roll back the partial entry before propagating.
    if (typeof restoreWorker === 'function') {
      for (const worker of state.suspended.reverse()) {
        try { await restoreWorker(worker); } catch { /* surfaced via throw below */ }
      }
    }
    if (typeof releaseGpu === 'function') {
      try { await releaseGpu(); } catch { /* surfaced via throw below */ }
    }
    state.state = STATES.FAILED;
    const err = new Error('Ollama unload failed; training resource mode aborted');
    err.ollama_unload = state.ollama_unload;
    throw err;
  }

  // 4) Verify GPU ownership before training may start.
  state.state = STATES.VERIFYING;
  await verifyGpu();

  state.state = STATES.TRAINING_ACTIVE;
  state.entered = true;
  return Object.freeze(state);
}

async function exitTrainingResourceMode(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const controllers = options.controllers || {};
  const suspended = Array.isArray(options.suspended)
    ? options.suspended
    : splitPipeList(config.training_suspend_workers);

  const releaseGpu = requireController(controllers, 'releaseGpu');
  const cleanContainer = requireController(controllers, 'cleanContainer');
  const restoreWorker = requireController(controllers, 'restoreWorker');
  const reloadOllama = requireController(controllers, 'reloadOllama');
  const verifyReady = requireController(controllers, 'verifyRuntimeReady');

  const result = {
    marker: 'FLOKI_V2_TRAINING_RESOURCE_EXIT',
    state: STATES.RESTORING,
    reason: options.reason || 'training_complete',
    released_gpu: false,
    cleaned_container: false,
    restored: [],
    ollama_reload: null,
    restoration_failures: [],
    ok: false
  };

  // Every restoration step is attempted; failures are recorded, not swallowed.
  try {
    await releaseGpu();
    result.released_gpu = true;
  } catch (err) {
    result.restoration_failures.push({ step: 'release_gpu', error: err.message });
  }

  try {
    await cleanContainer();
    result.cleaned_container = true;
  } catch (err) {
    result.restoration_failures.push({ step: 'clean_container', error: err.message });
  }

  for (const worker of suspended) {
    try {
      await restoreWorker(worker);
      result.restored.push(worker);
    } catch (err) {
      result.restoration_failures.push({ step: 'restore_worker:' + worker, error: err.message });
    }
  }

  try {
    result.ollama_reload = await reloadOllama();
    if (result.ollama_reload && result.ollama_reload.ok === false) {
      result.restoration_failures.push({ step: 'reload_ollama', error: result.ollama_reload.error || 'reload failed' });
    }
  } catch (err) {
    result.restoration_failures.push({ step: 'reload_ollama', error: err.message });
  }

  try {
    await verifyReady();
  } catch (err) {
    result.restoration_failures.push({ step: 'verify_ready', error: err.message });
  }

  result.ok = result.restoration_failures.length === 0;
  result.state = result.ok ? STATES.IDLE : STATES.FAILED;
  return Object.freeze(result);
}

module.exports = {
  STATES,
  enterTrainingResourceMode,
  exitTrainingResourceMode,
  splitPipeList
};
