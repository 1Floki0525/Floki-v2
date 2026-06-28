'use strict';

const { loadSelfImprovementConfig } = require('../config.cjs');
const gpuOwnership = require('./gpu-ownership.cjs');
const {
  unloadAllLoaded,
  reloadModel,
  splitPipeList
} = require('./ollama-control.cjs');

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new Error('training runtime controller missing ' + label);
  }
  return value;
}

function optionalFunction(value) {
  return typeof value === 'function' ? value : null;
}

async function stopKnowledge(knowledgeBootstrap) {
  if (!knowledgeBootstrap) {
    throw new Error('training runtime controller missing knowledgeBootstrap');
  }
  if (typeof knowledgeBootstrap.stopAndWait === 'function') {
    return knowledgeBootstrap.stopAndWait();
  }
  if (typeof knowledgeBootstrap.stop === 'function') {
    return knowledgeBootstrap.stop();
  }
  throw new Error('knowledge runtime bootstrap has no stop operation');
}

function acquireTrainingGpu(config, options = {}) {
  const gpu = options.gpu || gpuOwnership;
  const current = gpu.currentOwner(config);
  if (current === 'hf_training') {
    gpu.assertOwnedBy('hf_training', config);
    return gpu.readOwner(config);
  }
  if (current === null) {
    return gpu.acquire('hf_training', {
      reason: options.reason || 'training_resource_mode',
      run_id: options.run_id || null
    }, config);
  }
  if (!['ollama_cognition', 'vision'].includes(current)) {
    throw new Error('GPU is owned by ' + current + '; training cannot preempt it');
  }
  return gpu.transfer(current, 'hf_training', {
    reason: options.reason || 'training_resource_mode',
    run_id: options.run_id || null
  }, config);
}

async function restoreRuntimeResources(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const gpu = options.gpu || gpuOwnership;
  const shouldRestartKnowledge = options.restart_knowledge === true;
  const shouldRestoreLifecycle = options.restore_lifecycle !== false;
  const restartKnowledge = optionalFunction(options.restartKnowledge);
  const applyLifecycle = optionalFunction(options.applyLifecycle);
  const buildLifecycle = optionalFunction(options.buildLifecycle);

  const result = {
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_RESTORE',
    ok: false,
    reason: options.reason || 'training_finished',
    released_gpu: false,
    ollama_reload: [],
    knowledge_restart_required: shouldRestartKnowledge,
    knowledge_restarted: false,
    knowledge_restart_skipped: !shouldRestartKnowledge,
    lifecycle_restore_required: shouldRestoreLifecycle,
    lifecycle_restored: false,
    lifecycle_restore_skipped: !shouldRestoreLifecycle,
    failures: [],
    completed_at: null
  };

  try {
    const owner = gpu.currentOwner(config);
    if (owner === 'hf_training') {
      gpu.release('hf_training', config);
      result.released_gpu = true;
    } else if (owner === null) {
      result.released_gpu = true;
    } else if (options.allow_non_training_owner === true) {
      result.released_gpu = false;
    } else {
      throw new Error('cannot restore runtime while GPU owner is ' + owner);
    }
  } catch (error) {
    result.failures.push({ step: 'release_gpu', error: error.message });
  }

  if (options.reload_ollama !== false) {
    for (const endpoint of splitPipeList(config.ollama_unload_endpoints)) {
      try {
        const row = await reloadModel(
          endpoint,
          config.model.name,
          { httpJson: options.httpJson },
          config
        );
        result.ollama_reload.push(row);
        if (!row.ok) {
          result.failures.push({
            step: 'reload_ollama',
            endpoint,
            error: row.error || 'reload failed'
          });
        }
      } catch (error) {
        result.failures.push({
          step: 'reload_ollama',
          endpoint,
          error: error.message
        });
      }
    }
  }

  if (shouldRestartKnowledge) {
    if (!restartKnowledge) {
      result.failures.push({
        step: 'restart_knowledge',
        error: 'training runtime controller missing restartKnowledge'
      });
    } else {
      try {
        const knowledge = await restartKnowledge();
        result.knowledge_restart = knowledge || null;
        result.knowledge_restarted = true;
      } catch (error) {
        result.failures.push({
          step: 'restart_knowledge',
          error: error.message
        });
      }
    }
  }

  if (shouldRestoreLifecycle) {
    if (!applyLifecycle) {
      result.failures.push({
        step: 'restore_runtime_lifecycle',
        error: 'training runtime controller missing applyLifecycle'
      });
    } else if (!buildLifecycle) {
      result.failures.push({
        step: 'restore_runtime_lifecycle',
        error: 'training runtime controller missing buildLifecycle'
      });
    } else {
      try {
        await applyLifecycle(buildLifecycle());
        result.lifecycle_restored = true;
      } catch (error) {
        result.failures.push({
          step: 'restore_runtime_lifecycle',
          error: error.message
        });
      }
    }
  }

  result.completed_at = new Date().toISOString();
  result.ok = result.failures.length === 0;
  return Object.freeze(result);
}

async function enterTrainingRuntimeResourceMode(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const liveAudio = options.liveAudio;
  const visionReconciler = options.visionReconciler;
  requireFunction(liveAudio && liveAudio.setAwake, 'liveAudio.setAwake');
  requireFunction(
    visionReconciler && visionReconciler.reconcile,
    'visionReconciler.reconcile'
  );

  const result = {
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_ENTER',
    ok: false,
    run_id: options.run_id || null,
    hearing_suspended: false,
    vision_suspended: false,
    knowledge_suspended: false,
    ollama_unload_attempted: false,
    ollama_unload: null,
    gpu_owner: null,
    rollback: null,
    entered_at: new Date().toISOString()
  };

  try {
    await liveAudio.setAwake(false);
    result.hearing_suspended = true;

    await visionReconciler.reconcile(false, {
      awake: false,
      reason: 'training_resource_mode'
    });
    result.vision_suspended = true;

    result.knowledge_suspended = Boolean(
      await stopKnowledge(options.knowledgeBootstrap)
    );

    result.ollama_unload_attempted = true;
    result.ollama_unload = await unloadAllLoaded(
      { httpJson: options.httpJson },
      config
    );
    if (!result.ollama_unload || result.ollama_unload.ok !== true) {
      const error = new Error(
        'Ollama unload failed; training cannot acquire the GPU'
      );
      error.ollama_unload = result.ollama_unload;
      throw error;
    }

    const owner = acquireTrainingGpu(config, options);
    result.gpu_owner = owner && owner.owner;
    if (result.gpu_owner !== 'hf_training') {
      throw new Error(
        'GPU ownership verification failed after training acquisition'
      );
    }

    result.ok = true;
    return Object.freeze(result);
  } catch (error) {
    result.rollback = await restoreRuntimeResources({
      ...options,
      config,
      reason: 'training_resource_entry_failure',
      reload_ollama: result.ollama_unload_attempted,
      restart_knowledge: result.knowledge_suspended,
      restore_lifecycle: result.hearing_suspended || result.vision_suspended,
      allow_non_training_owner: true
    });
    const rollbackFailures = result.rollback && result.rollback.failures || [];
    const wrapped = new Error(
      'FLOKI_TRAINING_RESOURCE_ENTER_FAILED: ' + error.message +
      (rollbackFailures.length
        ? '\nrollback failures: ' + JSON.stringify(rollbackFailures)
        : '')
    );
    wrapped.cause = error;
    wrapped.resource_result = result;
    throw wrapped;
  }
}

async function exitTrainingRuntimeResourceMode(options = {}) {
  const result = await restoreRuntimeResources({
    ...options,
    reason: options.reason || 'training_finished',
    reload_ollama: true,
    restart_knowledge:
      options.restart_knowledge === true ||
      typeof options.restartKnowledge === 'function',
    restore_lifecycle: options.restore_lifecycle !== false,
    allow_non_training_owner: false
  });
  return Object.freeze({
    ...result,
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_EXIT'
  });
}

module.exports = {
  acquireTrainingGpu,
  enterTrainingRuntimeResourceMode,
  exitTrainingRuntimeResourceMode,
  optionalFunction,
  requireFunction,
  restoreRuntimeResources,
  stopKnowledge
};
