'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  loadFreshSelfImprovementConfig,
  loadSelfImprovementConfig
} = require('../config.cjs');
const { appendAudit, nowIso, readStatus, updateStatus } = require('../store.cjs');
const gpuOwnership = require('./gpu-ownership.cjs');
const { enterTrainingResource, exitTrainingResource } = require('./runtime-client.cjs');
const {
  checkpointNightlyTraining,
  createNightlySession,
  finalizeNightlyTraining,
  forceRemoveContainer,
  markNightlyTrainingError,
  readNightlySession,
  refreshNightlySession,
  setSessionResourceEntered,
  startNightlyTrainingSegment,
  writeSession
} = require('./nightly-training-session.cjs');
const { runHfRemGeneration } = require('./hf-rem-inference.cjs');
const { observeTrainingReality } = require('./training-observation.cjs');
const {
  withNightlyHfOperationLock
} = require('./nightly-hf-operation-lock.cjs');
const {
  getSleepWindowForDate,
  isWithinSleepWindow,
  loadSleepCycleState
} = require('../../chat/sleep-cycle.cjs');
const { readManualNapState } = require('../../chat/manual-nap.cjs');
const { runDreamEngineOnce } = require('../../chat/dream-engine.cjs');

function nowDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function automaticTrainingEnabled(config) {
  return config.training_enabled === true &&
    config.nightly_training_enabled === true;
}

function resolveNightlyProviders(config = {}) {
  const remProvider = typeof config.nightly_rem_provider === 'string'
    ? config.nightly_rem_provider.trim()
    : '';
  const hasTrainingProvider = Object.prototype.hasOwnProperty.call(
    config,
    'nightly_training_provider'
  );
  const trainingProvider = hasTrainingProvider &&
    typeof config.nightly_training_provider === 'string'
      ? config.nightly_training_provider.trim()
      : remProvider;

  if (!remProvider) {
    throw new Error(
      'FLOKI_NIGHTLY_REM_PROVIDER_INVALID: nightly_rem_provider is required'
    );
  }
  if (!trainingProvider) {
    throw new Error(
      'FLOKI_NIGHTLY_REM_PROVIDER_INVALID: nightly_training_provider is required'
    );
  }
  if (
    hasTrainingProvider &&
    config.nightly_rem_provider !== config.nightly_training_provider
  ) {
    throw new Error(
      'FLOKI_NIGHTLY_REM_PROVIDER_INVALID: configured REM provider must match the configured nightly training provider'
    );
  }

  return Object.freeze({
    nightly_rem_provider: remProvider,
    nightly_training_provider: trainingProvider,
    injected_training_provider_defaulted: !hasTrainingProvider
  });
}

function compactRestorationStatus(response) {
  const result = response && response.result && typeof response.result === 'object'
    ? response.result
    : response;
  if (!result || typeof result !== 'object') return null;
  return Object.freeze({
    marker: result.marker || null,
    ok: result.ok === true,
    reason: result.reason || null,
    released_gpu: result.released_gpu === true,
    ollama_reloaded:
      Array.isArray(result.ollama_reload) &&
      result.ollama_reload.some((row) => row && row.ok === true),
    audio_restarted: result.audio_restarted === true,
    knowledge_restarted: result.knowledge_restarted === true,
    scheduler_restarted: result.scheduler_restarted === true,
    lifecycle_restored: result.lifecycle_restored === true,
    failures: Array.isArray(result.failures) ? result.failures.slice(0, 20) : [],
    completed_at: result.completed_at || null
  });
}

function manualNapProductionActive(input = {}) {
  return input.manual_nap_active === true;
}

function nightlyTrainingDecision(input = {}) {
  const enabled = input.enabled === true;
  const within = input.within_sleep_window === true;
  const manualNap = manualNapProductionActive(input);
  const rsiPaused = input.rsi_paused === true;
  if (!enabled) {
    return Object.freeze({
      action: 'disabled',
      train_now: false,
      pause_for_manual_nap: false,
      pause_for_rsi_pause: false,
      restore_for_wake: false
    });
  }
  if (manualNap) {
    return Object.freeze({
      action: 'manual_nap_ollama',
      train_now: false,
      pause_for_manual_nap: true,
      pause_for_rsi_pause: false,
      restore_for_wake: false
    });
  }
  if (within && rsiPaused) {
    return Object.freeze({
      action: 'rsi_paused_wall_clock_rem',
      train_now: false,
      pause_for_manual_nap: false,
      pause_for_rsi_pause: true,
      restore_for_wake: false
    });
  }
  if (within) {
    return Object.freeze({
      action: 'nightly_training',
      train_now: true,
      pause_for_manual_nap: false,
      pause_for_rsi_pause: false,
      restore_for_wake: false
    });
  }
  return Object.freeze({
    action: 'wake_restoration',
    train_now: false,
    pause_for_manual_nap: false,
    pause_for_rsi_pause: false,
    restore_for_wake: true
  });
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      'nightly training JSON state is unreadable: ' + file + ': ' +
      (error && error.message ? error.message : String(error))
    );
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readRemClaims(config = loadSelfImprovementConfig()) {
  return readJson(config.training_rem_claim_file, {
    marker: 'FLOKI_V2_NIGHTLY_REM_CLAIMS',
    schema_version: 1,
    claims: {}
  });
}

function writeRemClaims(record, config = loadSelfImprovementConfig()) {
  atomicJson(config.training_rem_claim_file, record);
  return record;
}

function remClaimKey(input = {}) {
  const sleepDate = String(input.sleep_date || '').trim();
  const cycle = Number(input.rem_cycle_number);
  if (!sleepDate || !Number.isInteger(cycle) || cycle < 1) {
    throw new Error('nightly REM claim requires sleep_date and a positive cycle number');
  }
  return sleepDate + ':cycle-' + String(cycle);
}

function cachedDreamUsable(claim) {
  return Boolean(
    claim &&
    claim.status === 'complete' &&
    claim.result &&
    claim.result.ok === true &&
    claim.result.dream_txt_file &&
    fs.existsSync(claim.result.dream_txt_file) &&
    (!claim.result.dream_metadata_file || fs.existsSync(claim.result.dream_metadata_file))
  );
}

function recordClaimStart(input, config) {
  const store = readRemClaims(config);
  const claims = store && store.claims && typeof store.claims === 'object' ? store.claims : {};
  const previous = claims[input.key] || null;
  const next = {
    ...store,
    updated_at: nowIso(),
    claims: {
      ...claims,
      [input.key]: {
        marker: 'FLOKI_V2_NIGHTLY_REM_CLAIM',
        key: input.key,
        sleep_date: input.sleep_date,
        rem_cycle_number: input.rem_cycle_number,
        status: 'started',
        attempt: Number(previous && previous.attempt || 0) + 1,
        started_at: nowIso(),
        completed_at: null,
        failed_at: null,
        error: null,
        result: null
      }
    }
  };
  writeRemClaims(next, config);
  return next.claims[input.key];
}

function recordClaimComplete(key, result, config) {
  const store = readRemClaims(config);
  const claims = store && store.claims && typeof store.claims === 'object' ? store.claims : {};
  const current = claims[key] || {};
  const next = {
    ...store,
    updated_at: nowIso(),
    claims: {
      ...claims,
      [key]: {
        ...current,
        status: 'complete',
        completed_at: nowIso(),
        failed_at: null,
        error: null,
        result
      }
    }
  };
  writeRemClaims(next, config);
  return next.claims[key];
}

function recordClaimFailure(key, error, config) {
  const store = readRemClaims(config);
  const claims = store && store.claims && typeof store.claims === 'object' ? store.claims : {};
  const current = claims[key] || {};
  const message = error && error.stack ? error.stack : String(error && error.message || error);
  const next = {
    ...store,
    updated_at: nowIso(),
    claims: {
      ...claims,
      [key]: {
        ...current,
        status: 'failed',
        failed_at: nowIso(),
        error: message,
        result: null
      }
    }
  };
  writeRemClaims(next, config);
  return next.claims[key];
}

function dueNightlyRemNow(_now, session) {
  if (!session || session.active !== true) return false;
  if (session.finalized === true || session.aborted === true) return false;
  if (session.current_container) return false;
  const completedEpochs = Number(session.completed_epochs || 0);
  const completedRem = Number(session.rem_cycles_completed || 0);
  return completedEpochs > completedRem && Boolean(session.latest_checkpoint);
}

function transferGpuToRem(gpu, config, detail) {
  const owner = gpu.currentOwner(config);
  if (owner === 'hf_rem_inference') {
    return gpu.readOwner(config);
  }
  if (owner === 'hf_training') {
    return gpu.transfer('hf_training', 'hf_rem_inference', detail, config);
  }
  if (owner === null) {
    return gpu.acquire('hf_rem_inference', detail, config);
  }
  throw new Error('nightly REM cannot acquire GPU while owner is ' + owner);
}

function transferGpuBackToTraining(gpu, config, detail) {
  const owner = gpu.currentOwner(config);
  if (owner === 'hf_training') return gpu.readOwner(config);
  if (owner === 'hf_rem_inference') {
    return gpu.transfer('hf_rem_inference', 'hf_training', detail, config);
  }
  if (owner === null) {
    return gpu.acquire('hf_training', detail, config);
  }
  throw new Error('nightly training cannot resume while GPU owner is ' + owner);
}

function releaseRemGpu(gpu, config) {
  const owner = gpu.currentOwner(config);
  if (owner === 'hf_rem_inference') gpu.release('hf_rem_inference', config);
}

function createNightlyTrainingCoordinator(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const deps = {
    gpu: options.gpu || gpuOwnership,
    enterResource: options.enter_resource || enterTrainingResource,
    exitResource: options.exit_resource || exitTrainingResource,
    createSession: options.create_session || createNightlySession,
    readSession: options.read_session || readNightlySession,
    refreshSession: options.refresh_session || refreshNightlySession,
    writeSession: options.write_session || writeSession,
    setResourceEntered: options.set_resource_entered || setSessionResourceEntered,
    startSegment: options.start_segment || startNightlyTrainingSegment,
    checkpointSession: options.checkpoint_session || checkpointNightlyTraining,
    finalizeSession: options.finalize_session || finalizeNightlyTraining,
    forceContainer: options.force_container || forceRemoveContainer,
    markTrainingError: options.mark_training_error || markNightlyTrainingError,
    getSleepWindow: options.get_sleep_window || getSleepWindowForDate,
    isWithinSleepWindow: options.is_within_sleep_window || isWithinSleepWindow,
    readManualNap: options.read_manual_nap || readManualNapState,
    readSleepState: options.read_sleep_state || loadSleepCycleState,
    runDreamEngine: options.run_dream_engine || runDreamEngineOnce,
    runHfGeneration: options.run_hf_generation || runHfRemGeneration,
    loadConfig: options.load_config || loadFreshSelfImprovementConfig,
    audit: options.audit || ((type, detail) => appendAudit(type, detail, config)),
    status: options.status || ((patch) => updateStatus(patch, config)),
    readStatus: options.read_status || (() => readStatus(config)), observe: options.observe_training_reality || observeTrainingReality,
    // Injectable wall clock so the daytime night-cycle simulation can drive
    // the whole epoch -> REM -> resume loop on simulated timestamps without
    // touching the system clock. Production always uses the real clock.
    nowProvider: options.now_provider || (() => new Date())
  };

  async function ensureResource(session, reason) {
    const owner = deps.gpu.currentOwner(config);
    if (
      session &&
      session.resource_entered === true &&
      owner === 'hf_training'
    ) {
      return session;
    }
    if (session && session.resource_entered === true && owner !== 'hf_training') {
      session = deps.setResourceEntered(session, false, config);
    }
    const runId = session && session.run_id ||
      (config.nightly_training_run_id_prefix + '-' + String(Date.now()));
    const response = await deps.enterResource(runId, config);
    if (!response || response.ok !== true) {
      throw new Error('training resource entry did not return ok');
    }
    if (session) return deps.setResourceEntered(session, true, config);
    return session;
  }

  async function restoreResource(session, reason) {
    const owner = deps.gpu.currentOwner(config);
    if (owner === 'hf_rem_inference') {
      deps.gpu.release('hf_rem_inference', config);
    }
    const response = await deps.exitResource(reason, config);
    if (!response || response.ok !== true) {
      throw new Error('runtime resource restoration did not return ok');
    }
    if (!session) return null;
    const next = deps.setResourceEntered(session, false, config);
    return deps.writeSession({
      ...next,
      restoration: compactRestorationStatus(response),
      restored_at: nowIso(),
      updated_at: nowIso()
    }, config);
  }

  async function pauseTrainingForHandoff(session, handoff) {
    let current = session;
    if (current && current.current_container) {
      const checkpoint = await deps.checkpointSession(current, {
        config,
        reason: handoff.reason
      });
      current = checkpoint.session || current;
    }
    if (current && current.resource_entered === true) {
      current = await restoreResource(current, handoff.reason);
    }
    if (current) {
      current = deps.writeSession({
        ...current,
        status: handoff.session_status,
        updated_at: nowIso()
      }, config);
    }
    deps.status({
      phase: handoff.status_phase,
      current_container: null,
      training_resource_mode: 'idle',
      gpu_owner: null
    });
    return current;
  }

  async function pauseForManualNap(session) {
    return pauseTrainingForHandoff(session, {
      reason: 'manual_nap_ollama_handoff',
      session_status: 'paused_for_manual_nap',
      status_phase: 'nightly_training_paused_for_manual_nap'
    });
  }

  async function pauseForRsiPause(session) {
    return pauseTrainingForHandoff(session, {
      reason: 'rsi_paused_wall_clock_rem',
      session_status: 'paused_for_rsi_pause',
      status_phase: 'nightly_training_paused_for_rsi_pause'
    });
  }

  function rsiPausedNow(context = {}) {
    if (Object.prototype.hasOwnProperty.call(context, 'rsi_paused')) {
      return context.rsi_paused === true;
    }
    // The pause sentinel file is the canonical pause state (store.readStatus
    // derives its `paused` flag from this same file).
    if (
      typeof config.runtime_root === 'string' &&
      typeof config.pause_file_name === 'string'
    ) {
      try {
        return fs.existsSync(
          path.join(config.runtime_root, config.pause_file_name)
        );
      } catch (_error) {
        return false;
      }
    }
    return false;
  }

  async function reconcile(context = {}) {
    const observedAt = context.now ? nowDate(context.now) : deps.nowProvider();
    const enabled = automaticTrainingEnabled(config);
    const sleepWindow = deps.getSleepWindow(observedAt);
    const within = deps.isWithinSleepWindow(observedAt);
    const manualNap = deps.readManualNap({ now: observedAt });
    const decision = nightlyTrainingDecision({
      enabled,
      within_sleep_window: within,
      manual_nap_active: manualNap && manualNap.active === true,
      rsi_paused: rsiPausedNow(context)
    });
    let session = deps.readSession(config);

    if (decision.action === 'disabled') {
      return Object.freeze({ ok: true, action: decision.action, session });
    }

    if (decision.pause_for_manual_nap) {
      if (session && (session.resource_entered || session.current_container)) {
        session = await pauseForManualNap(session);
      }
      return Object.freeze({ ok: true, action: decision.action, session });
    }

    if (decision.pause_for_rsi_pause) {
      if (session && (session.resource_entered || session.current_container)) {
        session = await pauseForRsiPause(session);
      } else {
        const owner = deps.gpu.currentOwner(config);
        if (owner === 'hf_training' || owner === 'hf_rem_inference') {
          deps.gpu.release(owner, config);
        }
      }
      return Object.freeze({ ok: true, action: decision.action, session });
    }

    if (decision.restore_for_wake) {
      const performedRestorationWork = Boolean(session && (
        session.resource_entered === true ||
        (session.finalized !== true && session.current_container)
      ));
      if (session && session.finalized !== true && session.aborted !== true) {
        try {
          session = deps.refreshSession(session, { config });
          if (session.current_container) {
            const checkpoint = await deps.checkpointSession(session, {
              config,
              reason: 'wake_restoration',
              discard_partial_epoch: true
            });
            session = checkpoint.session || session;
          }
          if (dueNightlyRemNow(observedAt, session)) {
            await runNightlyRem({
              now: observedAt,
              env: context.env,
              rem_cycle_number: Number(session.rem_cycles_completed || 0) + 1,
              wake_boundary_completion: true
            });
            session = deps.readSession(config);
          }
          if (session && session.aborted !== true) {
            session = deps.finalizeSession(session, { config });
          }
        } finally {
          if (session && session.resource_entered === true) {
            session = await restoreResource(session, 'nightly_wake_restoration');
          }
        }
      } else if (session && session.resource_entered === true) {
        session = await restoreResource(session, 'nightly_wake_restoration');
      }
      if (performedRestorationWork) {
        deps.status({
          phase: session && session.aborted === true
            ? 'nightly_training_aborted'
            : 'daytime_idle',
          last_transition: session && session.aborted === true
            ? 'nightly_training_aborted'
            : 'nightly_wake_restored',
          last_transition_at: nowIso(),
          current_run_id: null,
          current_container: null,
          training_resource_mode: session && session.aborted === true
            ? 'aborted'
            : 'idle',
          gpu_owner: null,
          wake_restoration_error: null
        });
      } else {
        const persisted = deps.readStatus(config);
        if (persisted && persisted.phase === 'nightly_wake_restored') {
          deps.status({ phase: 'daytime_idle' });
        }
      }
      return Object.freeze({ ok: true, action: decision.action, session });
    }

    if (
      session &&
      session.sleep_date === sleepWindow.sleep_date &&
      (session.finalized === true || session.aborted === true)
    ) {
      return Object.freeze({
        ok: true,
        action: session.aborted === true
          ? 'nightly_training_aborted'
          : 'nightly_training_already_finalized',
        within_sleep_window: within,
        sleep_date: sleepWindow.sleep_date,
        session
      });
    }

    if (!session || session.sleep_date !== sleepWindow.sleep_date) {
      session = deps.createSession({ config, sleep_window: sleepWindow });
    }

    session = deps.refreshSession(session, { config });
    const sleepState = deps.readSleepState();
    if (sleepState && sleepState.interrupted === true) {
      return Object.freeze({
        ok: true,
        action: 'nightly_chat_interruption',
        within_sleep_window: within,
        sleep_date: sleepWindow.sleep_date,
        session
      });
    }

    if (dueNightlyRemNow(observedAt, session)) {
      const rem = await runNightlyRem({
        now: observedAt,
        env: context.env,
        rem_cycle_number: Number(session.rem_cycles_completed || 0) + 1
      });
      session = deps.readSession(config);
      return Object.freeze({
        ok: true,
        action: 'nightly_rem_after_completed_epoch',
        within_sleep_window: within,
        sleep_date: sleepWindow.sleep_date,
        session,
        rem
      });
    }

    if (session && session.training_failed === true && !session.current_container) {
      if (session.resource_entered === true) {
        session = await restoreResource(
          session,
          'nightly_training_failed_wall_clock_rem'
        );
      } else {
        const owner = deps.gpu.currentOwner(config);
        if (owner === 'hf_training' || owner === 'hf_rem_inference') {
          deps.gpu.release(owner, config);
        }
      }
      deps.status({
        state: 'failed',
        phase: 'nightly_training_failed_wall_clock_rem_active',
        current_container: null,
        training_resource_mode: 'idle',
        gpu_owner: null,
        nightly_training_error:
          session.training_error || 'nightly training failed'
      });
      return Object.freeze({
        ok: true,
        action: 'nightly_training_failed_wall_clock_rem',
        within_sleep_window: within,
        sleep_date: sleepWindow.sleep_date,
        session
      });
    }

    let observation = null;
    if (session.current_container) {
      observation = deps.observe({
        config,
        session,
        lock_owner: deps.gpu.currentOwner(config),
        release_owner: (owner) => deps.gpu.release(owner, config),
        reconcile_stale_owner: true,
        now_ms: observedAt.getTime()
      });
      if (observation.reconciliation_error) {
        throw new Error(observation.reconciliation_error);
      }
      deps.status({
        state: observation.live_training === true ? 'training' : observation.phase,
        phase: observation.live_training === true
          ? 'nightly_training_epoch_running'
          : 'nightly_training_container_starting',
        current_run_id: session.run_id,
        current_container: session.current_container,
        current_run_kind: 'training',
        training_resource_mode: observation.resource_mode,
        gpu_owner: observation.observed_gpu_owner,
        training_observation: observation,
        nightly_training_error: observation.error || null
      });
      return Object.freeze({
        ok: true,
        action: decision.action,
        training_action: observation.live_training === true
          ? 'nightly_training_epoch_running'
          : 'nightly_training_starting',
        within_sleep_window: within,
        sleep_date: sleepWindow.sleep_date,
        session,
        observation
      });
    }

    session = await ensureResource(session, 'nightly_training');
    transferGpuBackToTraining(deps.gpu, config, {
      reason: 'start_next_complete_epoch',
      run_id: session.run_id
    });
    session = deps.setResourceEntered(session, true, config);
    try {
      session = await deps.startSegment(session, { config: deps.loadConfig() });
    } catch (error) {
      let restorationError = null;
      try {
        session = deps.readSession(config) || session;
        if (session && session.resource_entered === true) {
          session = await restoreResource(session, 'nightly_training_launch_failure');
        } else {
          const owner = deps.gpu.currentOwner(config);
          if (owner === 'hf_training' || owner === 'hf_rem_inference') {
            deps.gpu.release(owner, config);
          }
        }
      } catch (restoreError) {
        restorationError = restoreError;
      }
      const failure = restorationError
        ? String(error.stack || error.message) + '\nresource restoration failed: ' +
          String(restorationError.stack || restorationError.message)
        : String(error.stack || error.message);
      deps.status({
        state: 'failed',
        phase: 'nightly_training_container_launch_failed',
        current_run_id: session && session.run_id || null,
        current_container: null,
        training_resource_mode: 'failed',
        gpu_owner: null,
        nightly_training_error: failure,
        last_error: failure
      });
      throw restorationError || error;
    }
    observation = deps.observe({
      config,
      session,
      lock_owner: deps.gpu.currentOwner(config),
      release_owner: (owner) => deps.gpu.release(owner, config),
      reconcile_stale_owner: true,
      now_ms: deps.nowProvider().getTime()
    });
    if (observation.reconciliation_error) {
      throw new Error(observation.reconciliation_error);
    }
    deps.status({
      state: observation.live_training === true ? 'training' : 'starting',
      phase: observation.live_training === true
        ? 'nightly_training_epoch_running'
        : 'nightly_training_container_starting',
      current_run_id: session.run_id,
      current_container: session.current_container || null,
      current_run_kind: 'training',
      training_resource_mode: observation.resource_mode,
      gpu_owner: observation.observed_gpu_owner,
      training_observation: observation,
      nightly_training_error: observation.error || null
    });
    return Object.freeze({
      ok: true,
      action: decision.action,
      training_action: 'nightly_training_epoch_started',
      within_sleep_window: within,
      sleep_date: sleepWindow.sleep_date,
      session,
      observation
    });
  }

  async function runNightlyRemUnlocked(dreamOptions = {}) {
    if (!automaticTrainingEnabled(config)) {
      throw new Error('FLOKI_NIGHTLY_REM_PROVIDER_DISABLED');
    }
    const providers = resolveNightlyProviders(config);

    let session = deps.readSession(config);
    const remObservedAt = dreamOptions.now
      ? nowDate(dreamOptions.now)
      : deps.nowProvider();
    const sleepWindow = deps.getSleepWindow(remObservedAt);
    const sleepDate = session && session.sleep_date || sleepWindow.sleep_date;
    if (!dueNightlyRemNow(dreamOptions.now, session)) {
      return Object.freeze({
        ok: true,
        skipped: true,
        reason: 'no_completed_epoch_waiting_for_rem',
        completed_epochs: Number(session && session.completed_epochs || 0),
        completed_rem_cycles: Number(session && session.rem_cycles_completed || 0)
      });
    }
    const cycleNumber = Number(session.rem_cycles_completed || 0) + 1;
    const key = remClaimKey({
      sleep_date: sleepDate,
      rem_cycle_number: cycleNumber
    });
    const existing = readRemClaims(config).claims[key];
    if (cachedDreamUsable(existing)) {
      return Object.freeze({
        ...existing.result,
        deduplicated_from_claim: true,
        rem_claim_key: key
      });
    }

    recordClaimStart({
      key,
      sleep_date: sleepDate,
      rem_cycle_number: cycleNumber
    }, config);

    let checkpointError = null;
    let remResult = null;
    let remError = null;
    const manualNapAtStart = deps.readManualNap({
      now: remObservedAt
    });
    let shouldResume =
      deps.isWithinSleepWindow(remObservedAt) &&
      !(manualNapAtStart && manualNapAtStart.active === true);

    try {
      if (!session || session.sleep_date !== sleepDate || session.finalized === true) {
        session = deps.createSession({ config, sleep_window: sleepWindow });
      }
      session = await ensureResource(session, 'nightly_rem');
      session = deps.refreshSession(session, { config });

      if (session.current_container) {
        try {
          const checkpoint = await deps.checkpointSession(session, {
            config,
            reason: 'nightly_rem_cycle_' + String(cycleNumber),
            require_epoch_boundary: true,
            sleep_window_end: sleepWindow.end_at
          });
          session = checkpoint.session || session;
          if (!checkpoint.ok) checkpointError = checkpoint.error;
        } catch (error) {
          const recoveryFailures = [
            { step: 'checkpoint_before_rem', error: error.message }
          ];
          if (session.current_container) {
            const failedContainer = session.current_container;
            try {
              deps.forceContainer(failedContainer, config);
            } catch (cleanupError) {
              recoveryFailures.push({
                step: 'force_remove_failed_training_container',
                error: cleanupError.message
              });
              throw new Error(
                'FLOKI_NIGHTLY_REM_UNSAFE_GPU_HANDOFF: ' +
                JSON.stringify(recoveryFailures)
              );
            }
            const failedSession = {
              ...session,
              current_container: null,
              training_failed: true,
              training_error: error.stack || error.message,
              updated_at: nowIso()
            };
            session = failedSession;
            try {
              session = deps.writeSession(failedSession, config);
            } catch (stateError) {
              recoveryFailures.push({
                step: 'persist_training_failure_before_rem',
                error: stateError.message
              });
            }
          }
          try {
            session = deps.markTrainingError(session, error, { config }) || session;
          } catch (statusError) {
            recoveryFailures.push({
              step: 'record_training_failure_before_rem',
              error: statusError.message
            });
          }
          checkpointError = recoveryFailures
            .map((failure) => failure.step + ': ' + failure.error)
            .join('; ');
        }
      }

      transferGpuToRem(deps.gpu, config, {
        reason: 'nightly_rem_cycle',
        run_id: session && session.run_id || null,
        rem_cycle_number: cycleNumber
      });
      deps.status({
        state: 'starting',
        phase: 'nightly_rem_hf_inference_starting',
        current_run_id: session && session.run_id || null,
        current_container: null,
        training_resource_mode: 'hf_rem_starting',
        gpu_owner: null,
        current_rem_cycle: cycleNumber,
        nightly_training_error: checkpointError,
        nightly_rem_error: null
      });
      deps.audit('nightly_rem_handoff_started', {
        run_id: session && session.run_id || null,
        sleep_date: sleepDate,
        rem_cycle_number: cycleNumber,
        checkpoint_error: checkpointError
      });

      // The dream engine is guarded by FLOKI_ALLOW_DREAM_ENGINE. The
      // scheduler tick env (context.env) carries the Maker's dream-engine
      // control decision; when this dispatch runs without a tick env (the
      // coordinator only fires after a REAL completed epoch inside the sleep
      // window) the sanctioned nightly allowance is applied explicitly, the
      // same way the manual-nap REM path does. Without this the first
      // epoch-triggered REM in history dies with FLOKI_V2_DREAM_ENGINE_BLOCKED
      // (found by the daytime night-cycle simulation on 2026-07-06).
      remResult = await deps.runDreamEngine({
        ...dreamOptions,
        env: dreamOptions.env || {
          ...process.env,
          FLOKI_ALLOW_DREAM_ENGINE: '1'
        },
        sleep_kind: 'nightly_sleep',
        fake_generator_counts_as_model: true,
        dream_generator: async ({ prompt, context, schema }) => deps.runHfGeneration({
          config,
          rem_id: key.replace(/[^a-zA-Z0-9_.-]/g, '-'),
          prompt,
          context,
          schema,
          system: config.hf_rem_system_prompt,
          temperature: dreamOptions.temperature,
          top_p: dreamOptions.top_p,
          max_new_tokens: dreamOptions.num_predict || dreamOptions.retry_num_predict
        })
      });

      if (!remResult || remResult.ok !== true || !remResult.dream_txt_file) {
        throw new Error(
          'FLOKI_NIGHTLY_REM_DREAM_FAILED: ' +
          String(remResult && (remResult.last_error || remResult.marker) || 'unknown')
        );
      }
      recordClaimComplete(key, remResult, config);
      if (session) {
        const remCyclesCompleted = Number(session.rem_cycles_completed || 0) + 1;
        session = deps.writeSession({
          ...session,
          status: 'rem_completed_waiting_for_epoch',
          rem_cycles_completed: remCyclesCompleted,
          last_rem_cycle_completed: cycleNumber,
          last_rem_completed_at: nowIso(),
          updated_at: nowIso()
        }, config);
      }
      deps.audit('nightly_rem_handoff_completed', {
        run_id: session && session.run_id || null,
        sleep_date: sleepDate,
        rem_cycle_number: cycleNumber,
        dream_txt_file: remResult.dream_txt_file,
        checkpoint_error: checkpointError
      });
      deps.status({
        phase: 'nightly_rem_complete',
        current_rem_cycle: cycleNumber,
        nightly_rem_error: null,
        last_nightly_rem_completed_at: nowIso()
      });
      const manualNapAfterRem = deps.readManualNap({ now: deps.nowProvider() });
      shouldResume = deps.isWithinSleepWindow(deps.nowProvider()) &&
        !(manualNapAfterRem && manualNapAfterRem.active === true);
      return Object.freeze({
        ...remResult,
        provider: providers.nightly_rem_provider,
        approved_lineage_only: true,
        rem_claim_key: key,
        checkpoint_error: checkpointError
      });
    } catch (error) {
      remError = error;
      recordClaimFailure(key, error, config);
      deps.audit('nightly_rem_handoff_failed', {
        run_id: session && session.run_id || null,
        sleep_date: sleepDate,
        rem_cycle_number: cycleNumber,
        error: error.stack || error.message,
        checkpoint_error: checkpointError
      });
      deps.status({
        phase: 'nightly_rem_failed',
        current_rem_cycle: cycleNumber,
        nightly_rem_error: error.stack || error.message,
        last_error: error.stack || error.message
      });
      throw error;
    } finally {
      try {
        if (
          shouldResume &&
          remResult &&
          remResult.ok === true &&
          session &&
          session.training_failed !== true
        ) {
          transferGpuBackToTraining(deps.gpu, config, {
            reason: 'resume_after_nightly_rem',
            run_id: session.run_id,
            rem_cycle_number: cycleNumber
          });
          session = deps.setResourceEntered(session, true, config);
          session = await deps.startSegment(session, { config: deps.loadConfig() });
          deps.status({
            phase: 'nightly_training_container_starting_after_rem',
            current_run_id: session.run_id,
            current_container: session.current_container,
            training_resource_mode: 'gpu_training_starting',
            gpu_owner: null
          });
        } else {
          releaseRemGpu(deps.gpu, config);
        }
      } catch (resumeError) {
        let restorationError = null;
        if (session) {
          try { session = deps.markTrainingError(session, resumeError, { config }) || session; }
          catch (markError) { restorationError = markError; }
        }
        try {
          if (session && session.resource_entered === true) {
            session = await restoreResource(session, 'nightly_training_resume_after_rem_failed');
          } else {
            const owner = deps.gpu.currentOwner(config);
            if (owner === 'hf_training' || owner === 'hf_rem_inference') {
              deps.gpu.release(owner, config);
            }
          }
        } catch (restoreError) {
          restorationError = restorationError || restoreError;
        }
        const failure = restorationError
          ? String(resumeError.stack || resumeError.message) + '\nresource restoration failed: ' +
            String(restorationError.stack || restorationError.message)
          : String(resumeError.stack || resumeError.message);
        deps.audit('nightly_training_resume_after_rem_failed', {
          run_id: session && session.run_id || null,
          rem_cycle_number: cycleNumber,
          error: failure,
          rem_error: remError && (remError.stack || remError.message) || null
        });
        deps.status({
          state: 'failed',
          phase: 'nightly_training_resume_after_rem_failed',
          current_container: null,
          training_resource_mode: 'failed',
          gpu_owner: null,
          nightly_training_error: failure,
          last_error: failure
        });
      }
    }
  }

  async function runNightlyRem(dreamOptions = {}) {
    return withNightlyHfOperationLock(
      'nightly_rem',
      () => runNightlyRemUnlocked(dreamOptions),
      deps.loadConfig()
    );
  }

  // Decides how REM cycles are scheduled for the current tick:
  // 'epoch_triggered' — REM fires after each completed training epoch;
  // 'wall_clock' — the fixed 10-minute schedule owns REM (RSI paused,
  // training terminally failed for this sleep date, or session closed).
  function remMode(context = {}) {
    if (!automaticTrainingEnabled(config)) return 'wall_clock';
    if (rsiPausedNow(context)) return 'wall_clock';
    const session = deps.readSession(config);
    if (!session) return 'epoch_triggered';
    const sleepWindow = deps.getSleepWindow(
      context.now ? nowDate(context.now) : deps.nowProvider()
    );
    if (session.sleep_date !== sleepWindow.sleep_date) {
      return 'epoch_triggered';
    }
    if (session.training_failed === true) return 'wall_clock';
    if (session.finalized === true || session.aborted === true) {
      return 'wall_clock';
    }
    return 'epoch_triggered';
  }

  async function shutdown(context = {}) {
    let session = deps.readSession(config);
    if (!session || session.finalized === true) return session;
    try {
      if (session.current_container) {
        const checkpoint = await deps.checkpointSession(session, {
          config,
          reason: context.reason || 'scheduler_shutdown'
        });
        session = checkpoint.session || session;
      }
    } finally {
      if (session && session.resource_entered === true) {
        session = await restoreResource(session, context.reason || 'scheduler_shutdown');
      }
      if (session) {
        session = deps.writeSession({
          ...session,
          status: 'paused_for_scheduler_shutdown',
          updated_at: nowIso()
        }, config);
      }
    }
    return session;
  }

  return Object.freeze({
    afterTick: reconcile,
    beforeTick: reconcile,
    reconcile,
    remMode,
    runNightlyRem,
    shutdown
  });
}

let productionCoordinator = null;

function getProductionNightlyTrainingCoordinator() {
  if (!productionCoordinator) {
    productionCoordinator = createNightlyTrainingCoordinator();
  }
  return productionCoordinator;
}

function resetProductionNightlyTrainingCoordinatorForTests() {
  productionCoordinator = null;
}

module.exports = {
  manualNapProductionActive,
  compactRestorationStatus,
  automaticTrainingEnabled,
  cachedDreamUsable,
  createNightlyTrainingCoordinator,
  dueNightlyRemNow,
  getProductionNightlyTrainingCoordinator,
  nightlyTrainingDecision,
  readRemClaims,
  resolveNightlyProviders,
  recordClaimComplete,
  recordClaimFailure,
  recordClaimStart,
  remClaimKey,
  resetProductionNightlyTrainingCoordinatorForTests,
  transferGpuBackToTraining,
  transferGpuToRem,
  writeRemClaims
};
