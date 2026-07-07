'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('../config.cjs');
const gpuOwnership = require('./gpu-ownership.cjs');
const {
  queryLoadedModels,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLastJsonLine(value) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_error) {
      // Continue searching older lines.
    }
  }
  return null;
}

function runConfiguredScript(config, key, options = {}) {
  const configured = String(config[key] || '').trim();
  if (!configured) {
    throw new Error('missing YAML self_improvement.' + key);
  }
  const scriptPath = path.isAbsolute(configured)
    ? configured
    : path.resolve(config.project_root, configured);
  const execute = options.spawnSync || spawnSync;
  const result = execute(
    config.training_shell_command,
    [scriptPath],
    {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: config.runtime_transition_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      key + ' failed: ' +
      String(result.stderr || result.stdout || 'status=' + String(result.status)).trim()
    );
  }
  return Object.freeze({
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    record: parseLastJsonLine(result.stdout)
  });
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

async function stopLiveAudio(liveAudio) {
  if (!liveAudio) {
    throw new Error('training runtime controller missing liveAudio');
  }
  if (typeof liveAudio.stop === 'function') {
    await liveAudio.stop();
    return 'stopped_recorder_vad_whisper';
  }
  // Narrow compatibility for injected contract-test doubles. Production has
  // liveAudio.stop(), which terminates recorder, VAD, and Whisper.
  requireFunction(liveAudio.setAwake, 'liveAudio.stop');
  await liveAudio.setAwake(false);
  return 'compatibility_set_awake_false';
}

async function startLiveAudio(liveAudio) {
  if (!liveAudio) return false;
  if (typeof liveAudio.start === 'function') {
    await liveAudio.start();
    return true;
  }
  if (typeof liveAudio.setAwake === 'function') {
    await liveAudio.setAwake(true);
    return true;
  }
  return false;
}

function parseNvidiaComputeRows(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      return Object.freeze({
        pid: Number(parts[0]),
        process_name: parts[1] || 'unknown',
        used_memory_mb: Number(parts[2])
      });
    });
}

function queryGpuComputeProcesses(config, options = {}) {
  if (typeof options.queryGpuComputeProcesses === 'function') {
    return options.queryGpuComputeProcesses();
  }
  const execute = options.spawnSync || spawnSync;
  const command = String(config.training_gpu_process_query_command);
  const args = splitPipeList(config.training_gpu_process_query_args);
  const result = execute(command, args, {
    cwd: config.project_root,
    encoding: 'utf8',
    timeout: config.training_gpu_query_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'configured GPU compute-process query failed: ' +
      String(result.stderr || result.stdout || 'status=' + result.status).trim()
    );
  }
  return parseNvidiaComputeRows(result.stdout);
}

async function waitForGpuComputeQuiescence(config, options = {}) {
  const timeoutMs = Number(config.training_gpu_quiesce_timeout_ms);
  const pollMs = Number(config.training_gpu_quiesce_poll_ms);
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  do {
    rows = await Promise.resolve(queryGpuComputeProcesses(config, options));
    if (!Array.isArray(rows)) {
      throw new Error('GPU process query must return an array');
    }
    if (rows.length === 0) {
      return Object.freeze({
        ok: true,
        compute_processes: Object.freeze([]),
        verified_at: new Date().toISOString()
      });
    }
    if (Date.now() >= deadline) break;
    await delay(pollMs);
  } while (true);

  throw new Error(
    'FLOKI_TRAINING_GPU_NOT_EXCLUSIVE: compute processes still own the GPU after ' +
    String(timeoutMs) + 'ms: ' + JSON.stringify(rows)
  );
}

function resolveNightlyRestorePolicy(
  config,
  reason,
  observedAt = new Date(),
  options = {}
) {
  const isWithin = options.is_within_sleep_window ||
    require('../../chat/sleep-cycle.cjs').isWithinSleepWindow;
  const policy = String(
    config.nightly_ollama_reload_policy || 'wake_only'
  ).trim();
  const wakeRestoration =
    reason === 'nightly_wake_restoration' ||
    reason === 'wake_restoration';
  // Wall-clock fallback moments: training is paused, failed, or could not
  // launch/resume, so the night falls back to wall-clock dreams. Those dreams
  // need live cognition immediately, so the Ollama reload must NOT defer to
  // wake even though we are still inside the sleep window. Ordinary mid-night
  // REM handoffs (nightly_rem_cycle_N) keep deferring under the wake_only policy.
  const wallClockFallback =
    reason === 'rsi_paused_wall_clock_rem' ||
    reason === 'nightly_training_failed_wall_clock_rem' ||
    reason === 'nightly_training_launch_failure' ||
    reason === 'nightly_training_resume_after_rem_failed';
  const forceImmediateRestore = wakeRestoration || wallClockFallback;
  const withinNight = isWithin(observedAt);
  const deferUntilWake =
    policy === 'wake_only' && withinNight && !forceImmediateRestore;
  return Object.freeze({
    policy,
    within_night: withinNight,
    wake_restoration: wakeRestoration,
    wall_clock_fallback: wallClockFallback,
    defer_until_wake: deferUntilWake,
    reload_ollama: !deferUntilWake,
    restore_daytime_services: !deferUntilWake
  });
}

async function verifyOllamaUnloaded(config, options = {}) {
  const endpoints = splitPipeList(config.ollama_unload_endpoints);
  const loaded = [];
  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const listing = await queryLoadedModels(
        endpoint,
        { httpJson: options.httpJson },
        config
      );
      if (!listing.ok) {
        failures.push({ endpoint, error: 'Ollama /api/ps verification failed' });
        continue;
      }
      for (const model of listing.models) loaded.push({ endpoint, model });
    } catch (error) {
      failures.push({ endpoint, error: error.message });
    }
  }
  return Object.freeze({
    ok: failures.length === 0 && loaded.length === 0,
    marker: 'FLOKI_V2_OLLAMA_UNLOADED_VERIFIED',
    endpoints,
    loaded,
    failures
  });
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
  const restorePolicy = resolveNightlyRestorePolicy(
    config,
    options.reason || 'training_finished',
    options.now || new Date(),
    options
  );
  const gpu = options.gpu || gpuOwnership;
  const shouldRestartKnowledge =
    restorePolicy.restore_daytime_services &&
    options.restart_knowledge === true;
  const shouldRestartScheduler = false;
  const shouldRestoreLifecycle =
    restorePolicy.restore_daytime_services &&
    options.restore_lifecycle !== false;
  const restartKnowledge = optionalFunction(options.restartKnowledge);
  const applyLifecycle = optionalFunction(options.applyLifecycle);
  const buildLifecycle = optionalFunction(options.buildLifecycle);

  const result = {
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_RESTORE',
    ok: false,
    reason: options.reason || 'training_finished',
    released_gpu: false,
    ollama_reload: [],
    audio_restart_required: options.restart_audio === true,
    audio_restarted: false,
    knowledge_restart_required: shouldRestartKnowledge,
    knowledge_restarted: false,
    knowledge_restart_skipped: !shouldRestartKnowledge,
    scheduler_restart_required: shouldRestartScheduler,
    scheduler_restarted: false,
    lifecycle_restore_required: shouldRestoreLifecycle,
    lifecycle_restored: false,
    lifecycle_restore_skipped: !shouldRestoreLifecycle,
    failures: [],
    completed_at: null
  };

  try {
    const owner = gpu.currentOwner(config);
    if (owner === 'hf_training' || owner === 'hf_rem_inference') {
      gpu.release(owner, config);
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

  if (restorePolicy.reload_ollama && options.reload_ollama !== false) {
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
        result.knowledge_restart = await restartKnowledge() || null;
        result.knowledge_restarted = true;
      } catch (error) {
        result.failures.push({ step: 'restart_knowledge', error: error.message });
      }
    }
  }

  if (options.restart_audio === true) {
    try {
      result.audio_restarted = await startLiveAudio(options.liveAudio);
    } catch (error) {
      result.failures.push({ step: 'restart_live_audio', error: error.message });
    }
  }

  if (shouldRestoreLifecycle) {
    if (!applyLifecycle || !buildLifecycle) {
      const missing = [];
      if (!applyLifecycle) missing.push('applyLifecycle');
      if (!buildLifecycle) missing.push('buildLifecycle');
      result.failures.push({
        step: 'restore_runtime_lifecycle',
        error:
          'training runtime controller missing ' +
          missing.join(' and ')
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

  if (shouldRestartScheduler) {
    try {
      result.scheduler_restart = runConfiguredScript(
        config,
        'training_sleep_scheduler_start_script',
        options
      );
      result.scheduler_restarted = true;
    } catch (error) {
      result.failures.push({
        step: 'restart_sleep_scheduler',
        error: error.message
      });
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
  requireFunction(
    visionReconciler && visionReconciler.reconcile,
    'visionReconciler.reconcile'
  );

  const result = {
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_ENTER',
    ok: false,
    run_id: options.run_id || null,
    scheduler_suspended: false,
    scheduler_restart_required: false,
    scheduler_preserved: true,
    hearing_suspended: false,
    hearing_stop_mode: null,
    vision_suspended: false,
    knowledge_suspended: false,
    ollama_unload_attempted: false,
    ollama_unload: null,
    gpu_quiescence: null,
    gpu_owner: null,
    rollback: null,
    entered_at: new Date().toISOString()
  };

  try {
    // The sleep-cycle scheduler is the coordinator for the nightly
    // epoch/REM state machine. Entering HF resource mode must never stop the
    // process that owns subsequent epoch boundaries, REM handoffs, wake
    // finalization, failure recovery, or abort processing.
    result.scheduler_suspended = false;
    result.scheduler_restart_required = false;
    result.scheduler_preserved = true;

    result.hearing_stop_mode = await stopLiveAudio(liveAudio);
    result.hearing_suspended = true;

    await visionReconciler.reconcile(false, {
      awake: false,
      reason: 'training_resource_mode'
    });
    result.vision_suspended = true;

    await stopKnowledge(options.knowledgeBootstrap);
    result.knowledge_suspended = true;

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

    result.gpu_quiescence = await waitForGpuComputeQuiescence(config, options);

    result.ollama_unload_verification =
      await verifyOllamaUnloaded(config, options);
    if (result.ollama_unload_verification.ok !== true) {
      const error = new Error(
        'Ollama remained loaded after unload; HF GPU ownership denied'
      );
      error.ollama_unload_verification =
        result.ollama_unload_verification;
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
      restart_audio: result.hearing_suspended,
      restart_scheduler: false,
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
  const config = options.config || loadSelfImprovementConfig();
  const reason = options.reason || 'training_finished';
  const policy = resolveNightlyRestorePolicy(
    config,
    reason,
    options.now || new Date(),
    options
  );
  const restoreDaytime = policy.restore_daytime_services;
  const result = await restoreRuntimeResources({
    ...options,
    config,
    reason,
    reload_ollama: restoreDaytime && options.reload_ollama !== false,
    restart_knowledge:
      restoreDaytime &&
      (
        options.restart_knowledge === true ||
        typeof options.restartKnowledge === 'function'
      ),
    restart_audio: restoreDaytime && options.restart_audio !== false,
    restart_scheduler: false,
    restore_lifecycle:
      restoreDaytime && options.restore_lifecycle !== false,
    allow_non_training_owner: false
  });
  return Object.freeze({
    ...result,
    marker: 'FLOKI_V2_TRAINING_RUNTIME_RESOURCE_EXIT'
  });
}

module.exports = {
  verifyOllamaUnloaded,
  resolveNightlyRestorePolicy,
  acquireTrainingGpu,
  enterTrainingRuntimeResourceMode,
  exitTrainingRuntimeResourceMode,
  optionalFunction,
  parseNvidiaComputeRows,
  queryGpuComputeProcesses,
  requireFunction,
  restoreRuntimeResources,
  runConfiguredScript,
  startLiveAudio,
  stopKnowledge,
  stopLiveAudio,
  waitForGpuComputeQuiescence
};
