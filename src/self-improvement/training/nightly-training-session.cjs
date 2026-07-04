'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { loadSelfImprovementConfig } = require('../config.cjs');
const {
  appendAudit,
  atomicJson,
  nowIso,
  paths,
  updateStatus
} = require('../store.cjs');
const { waitForContainerStart } = require('../sandbox.cjs');
const { assertHfMasterReady } = require('./master-preflight.cjs');
const { buildDataset } = require('./dataset-builder.cjs');
const { buildTrainingConfig, buildTrainingRunArgs } = require('./qlora-config.cjs');
const {
  createLineageRecord,
  nextAdapterVersion,
  persistLineage
} = require('./lineage.cjs');
const {
  ensureTrainingImage,
  validateTrainingArtifacts,
  writeAdapterCandidate
} = require('./training-runner.cjs');

function sessionFile(config = loadSelfImprovementConfig()) {
  return path.join(
    config.training_runtime_root,
    config.nightly_training_session_file_name
  );
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      'nightly training state is unreadable: ' + file + ': ' +
      (error && error.message ? error.message : String(error))
    );
  }
}

function readJson(file, fallback = null) {
  const value = readOptionalJson(file);
  return value === null ? fallback : value;
}

function writeSession(session, config = loadSelfImprovementConfig()) {
  atomicJson(sessionFile(config), session, config);
  return Object.freeze(session);
}

function readNightlySession(config = loadSelfImprovementConfig()) {
  const current = readOptionalJson(sessionFile(config));
  return current ? Object.freeze(current) : null;
}

function containerRunning(containerName, config = loadSelfImprovementConfig(), options = {}) {
  if (!containerName) return false;
  const execute = options.spawnSync || spawnSync;
  const result = execute(
    config.sandbox_engine,
    ['inspect', '--format', '{{.State.Running}}', containerName],
    {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: config.podman_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    if (/no such (?:container|object)/i.test(detail)) return false;
    throw new Error('training container inspection failed: ' + detail);
  }
  return String(result.stdout || '').trim() === 'true';
}

function containerAbsent(detail) {
  return /(?:no such (?:container|object)|no container with (?:name|id)|does not exist|not found)/i.test(String(detail || ''));
}

function forceRemoveContainer(containerName, config = loadSelfImprovementConfig(), options = {}) {
  if (!containerName) {
    return Object.freeze({ ok: true, removed: false, reason: 'container_name_absent' });
  }
  const execute = options.spawnSync || spawnSync;
  const result = execute(config.sandbox_engine, ['rm', '-f', containerName], {
    cwd: config.project_root,
    encoding: 'utf8',
    timeout: config.podman_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.error) throw result.error;
  const detail = String(result.stderr || result.stdout || '').trim();
  if (result.status !== 0) {
    if (!containerAbsent(detail)) {
      throw new Error(
        'FLOKI_NIGHTLY_TRAINING_CONTAINER_CLEANUP_FAILED: ' +
        (detail || 'status=' + String(result.status))
      );
    }
    return Object.freeze({ ok: true, removed: false, reason: 'already_absent' });
  }
  return Object.freeze({ ok: true, removed: true, reason: null });
}

function waitForDetachedContainerLaunch(child, containerName, config, options = {}) {
  const waitForStart = options.waitForContainerStart || waitForContainerStart;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    child.once('error', onError);
    Promise.resolve()
      .then(() => waitForStart(containerName, config))
      .then(() => finish(null), finish);
  });
}

function latestCheckpoint(adapterDir, config = loadSelfImprovementConfig()) {
  if (!fs.existsSync(adapterDir)) return null;
  return fs.readdirSync(adapterDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && new RegExp('^' + config.training_checkpoint_dir_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d+$').test(entry.name))
    .map((entry) => ({
      step: Number(entry.name.slice(config.training_checkpoint_dir_prefix.length)),
      dir: path.join(adapterDir, entry.name)
    }))
    .filter((row) => fs.existsSync(path.join(row.dir, config.training_trainer_state_file_name)))
    .sort((left, right) => right.step - left.step)[0] || null;
}

function completedEpochFromCheckpoint(checkpoint, config = loadSelfImprovementConfig()) {
  if (!checkpoint || !checkpoint.dir) return 0;
  const state = readJson(
    path.join(checkpoint.dir, config.training_trainer_state_file_name),
    null
  );
  const epoch = Number(state && state.epoch);
  if (!Number.isFinite(epoch) || epoch < 1) return 0;
  return Math.floor(epoch + 1e-9);
}

function sessionRunId(sleepDate, config = loadSelfImprovementConfig()) {
  return config.nightly_training_run_id_prefix + '-' + String(sleepDate || 'unknown').replace(/[^0-9-]/g, '') + '-' + crypto.randomBytes(config.nightly_training_run_id_random_bytes).toString('hex');
}

function sessionPaths(runId, config = loadSelfImprovementConfig()) {
  const root = path.join(config.training_runtime_root, runId);
  const adapterOutput = path.join(root, config.training_adapter_output_dir_name);
  return Object.freeze({
    root,
    adapter_output: adapterOutput,
    log_file: path.join(root, config.training_log_file_name),
    training_config_file: path.join(root, config.training_config_file_name),
    control_file: path.join(adapterOutput, config.nightly_training_control_file_name),
    control_response_file: path.join(adapterOutput, config.nightly_training_control_response_file_name)
  });
}

function containerControlPaths(config = loadSelfImprovementConfig()) {
  return Object.freeze({
    control_file: path.posix.join(config.training_adapter_mount_path, config.nightly_training_control_file_name),
    control_response_file: path.posix.join(config.training_adapter_mount_path, config.nightly_training_control_response_file_name)
  });
}

function buildNightlyTrainingConfig(baseConfig, session, config) {
  const control = containerControlPaths(config);
  const segmentNumber = Number(session.segment_number || 0) + 1;
  return Object.freeze({
    ...baseConfig,
    training: Object.freeze({
      ...baseConfig.training,
      num_train_epochs: segmentNumber,
      max_steps: -1,
      save_strategy: 'epoch',
      save_total_limit: Number(config.nightly_training_save_total_limit)
    }),
    scheduler: Object.freeze({
      mode: config.nightly_training_mode,
      segment_number: segmentNumber,
      resume_from_checkpoint: config.nightly_training_resume_policy,
      control_file: control.control_file,
      control_response_file: control.control_response_file,
      checkpoint_before_rem: config.training_checkpoint_before_rem === true,
      epoch_boundary_only: true
    })
  });
}

function createNightlySession(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const sleepWindow = options.sleep_window;
  if (!sleepWindow || !sleepWindow.sleep_date) {
    throw new Error('nightly training session requires a sleep window');
  }

  const existing = readNightlySession(config);
  if (
    existing &&
    existing.sleep_date === sleepWindow.sleep_date
  ) {
    return existing;
  }

  const runId = sessionRunId(sleepWindow.sleep_date, config);
  const runtime = sessionPaths(runId, config);
  fs.mkdirSync(runtime.adapter_output, { recursive: true, mode: 0o700 });

  const preflight = assertHfMasterReady(config);
  const dataset = buildDataset({ config });
  const image = ensureTrainingImage(config);
  const baseTrainingConfig = buildTrainingConfig({ config });

  const session = {
    marker: 'FLOKI_V2_NIGHTLY_TRAINING_SESSION',
    schema_version: 1,
    run_id: runId,
    sleep_date: sleepWindow.sleep_date,
    sleep_window_start: sleepWindow.start_at,
    sleep_window_end: sleepWindow.end_at,
    status: 'prepared',
    active: true,
    finalized: false,
    resource_entered: false,
    training_failed: false,
    training_error: null,
    training_config_sha256: null,
    current_container: null,
    segment_number: 0,
    completed_epochs: 0,
    rem_cycles_completed: 0,
    last_completed_epoch: null,
    last_rem_cycle_completed: null,
    segment_started_at: null,
    last_checkpoint_at: null,
    latest_checkpoint: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    runtime,
    hf_master: {
      path: preflight.path,
      identity: path.basename(preflight.path)
    },
    dataset: {
      dataset_id: dataset.dataset_id,
      root: dataset.root,
      records_sha256: dataset.records_sha256,
      record_count: dataset.record_count
    },
    image,
    base_training_config: baseTrainingConfig,
    candidate_id: null,
    adapter_id: null,
    restoration: null
  };

  writeSession(session, config);
  appendAudit('nightly_training_session_prepared', {
    run_id: runId,
    sleep_date: sleepWindow.sleep_date,
    dataset_id: dataset.dataset_id,
    image_rebuilt: image.rebuilt
  }, config);
  updateStatus({
    state: 'prepared',
    phase: 'nightly_training_prepared',
    current_run_id: runId,
    current_run_kind: 'training',
    current_candidate_type: 'model_adapter',
    current_objective: config.nightly_training_default_objective,
    training_resource_mode: 'prepared',
    training_progress: {
      run_id: runId,
      sleep_date: sleepWindow.sleep_date,
      dataset_id: dataset.dataset_id,
      segment_number: 0,
      prepared_at: session.created_at
    },
    nightly_training_error: null
  }, config);
  return Object.freeze(session);
}

function setSessionResourceEntered(session, entered, config = loadSelfImprovementConfig()) {
  if (!session) return null;
  return writeSession({
    ...session,
    resource_entered: entered === true,
    status: entered === true ? 'resource_ready' : session.status,
    updated_at: nowIso()
  }, config);
}

function trainingConfigFingerprint(value) {
  const normalized = JSON.parse(
    JSON.stringify(value || {})
  );

  if (
    normalized.training &&
    typeof normalized.training === 'object'
  ) {
    delete normalized.training.num_train_epochs;
  }

  if (
    normalized.scheduler &&
    typeof normalized.scheduler === 'object'
  ) {
    delete normalized.scheduler.segment_number;
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function writeTrainingConfig(session, config = loadSelfImprovementConfig()) {
  const currentBaseTrainingConfig = buildTrainingConfig({
    config
  });
  const nextConfig = buildNightlyTrainingConfig(
    currentBaseTrainingConfig,
    session,
    config
  );
  fs.mkdirSync(path.dirname(session.runtime.training_config_file), {
    recursive: true,
    mode: 0o700
  });
  fs.writeFileSync(
    session.runtime.training_config_file,
    JSON.stringify(nextConfig, null, 2) + '\n',
    { mode: 0o600 }
  );
  return Object.freeze({
    config: nextConfig,
    fingerprint:
      trainingConfigFingerprint(nextConfig)
  });
}

async function startNightlyTrainingSegment(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (!session || session.active !== true || session.finalized === true) {
    return session;
  }
  if (session.current_container && containerRunning(session.current_container, config)) {
    return session;
  }
  if (session.resource_entered !== true) {
    throw new Error('nightly training resource mode is not active');
  }

  const preparedTraining = writeTrainingConfig(
    session,
    config
  );
  const failedConfigUnchanged = Boolean(
    session.training_failed === true &&
    session.training_config_sha256 &&
    session.training_config_sha256 ===
      preparedTraining.fingerprint
  );
  if (
    session.training_failed === true &&
    options.retry_failed !== true &&
    failedConfigUnchanged
  ) {
    return session;
  }
  const retryingAfterConfigChange = Boolean(
    session.training_failed === true &&
    !failedConfigUnchanged
  );

  const completedEpochs = Number(session.completed_epochs || 0);
  const completedRemCycles = Number(session.rem_cycles_completed || 0);
  if (completedEpochs > completedRemCycles) {
    const waiting = writeSession({
      ...session,
      status: 'waiting_for_rem_before_next_epoch',
      updated_at: nowIso()
    }, config);
    updateStatus({
      state: 'prepared',
      phase: 'nightly_waiting_for_rem_before_next_epoch',
      current_run_id: session.run_id,
      current_container: null,
      training_resource_mode: 'epoch_complete_waiting_for_rem',
      gpu_owner: null,
      training_progress: {
        run_id: session.run_id,
        sleep_date: session.sleep_date,
        completed_epochs: completedEpochs,
        rem_cycles_completed: completedRemCycles,
        waiting_for: 'rem_before_epoch'
      }
    }, config);
    return waiting;
  }

  fs.rmSync(session.runtime.control_file, { force: true });
  fs.rmSync(session.runtime.control_response_file, { force: true });
  const trainingConfig = preparedTraining.config;
  const segmentNumber = Number(
    trainingConfig.scheduler.segment_number
  );
  const containerName = config.training_container_name_prefix + '-' + session.run_id.replace(/[^a-zA-Z0-9_.-]/g, '-') + '-s' + String(segmentNumber);
  const args = buildTrainingRunArgs({
    config,
    containerName,
    hfMasterPath: session.hf_master.path,
    datasetDir: session.dataset.root,
    adapterOutDir: session.runtime.adapter_output,
    trainingConfigFile: session.runtime.training_config_file
  });

  let descriptor = null;
  let launchError = null;
  let closeError = null;
  try {
    fs.mkdirSync(path.dirname(session.runtime.log_file), { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(session.runtime.log_file, 'a', 0o600);
    atomicJson(paths(config).currentContainerFile, {
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_CURRENT_CONTAINER',
      run_id: session.run_id,
      kind: 'training',
      candidate_type: 'model_adapter',
      name: containerName,
      segment_number: segmentNumber,
      created_at: nowIso(),
      stop_requested_at: null,
      stop_reason: null
    }, config);

    const child = spawn(config.sandbox_engine, args, {
      cwd: config.project_root,
      env: process.env,
      detached: true,
      stdio: ['ignore', descriptor, descriptor]
    });
    child.unref();
    await waitForDetachedContainerLaunch(child, containerName, config);
  } catch (error) {
    launchError = error;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        closeError = error;
      }
    }
  }

  if (launchError || closeError) {
    const failures = [];
    if (launchError) failures.push({ step: 'launch_or_start', error: launchError.message });
    if (closeError) failures.push({ step: 'close_training_log', error: closeError.message });
    try {
      const cleanup = forceRemoveContainer(containerName, config);
      appendAudit('nightly_training_container_cleanup', {
        run_id: session.run_id,
        container: containerName,
        cleanup
      }, config);
    } catch (error) {
      failures.push({ step: 'remove_training_container', error: error.message });
    }
    try {
      fs.rmSync(paths(config).currentContainerFile, { force: true });
    } catch (error) {
      failures.push({ step: 'remove_current_container_state', error: error.message });
    }
    const message = 'nightly training segment launch failed: ' + JSON.stringify(failures);
    writeSession({
      ...session,
      status: 'failed',
      current_container: null,
      training_failed: true,
      training_error: message,
      training_config_sha256:
        preparedTraining.fingerprint,
      updated_at: nowIso()
    }, config);
    appendAudit('nightly_training_segment_launch_failed', {
      run_id: session.run_id,
      container: containerName,
      segment_number: segmentNumber,
      failures
    }, config);
    updateStatus({
      state: 'failed',
      phase: 'nightly_training_segment_launch_failed',
      current_run_id: session.run_id,
      current_container: null,
      training_resource_mode: 'active',
      gpu_owner: 'hf_training',
      nightly_training_error: message,
      last_error: message,
      failure_latched_at: nowIso()
    }, config);
    throw new Error(message);
  }

  const next = writeSession({
    ...session,
    status: 'training',
    current_container: containerName,
    segment_number: segmentNumber,
    segment_started_at: nowIso(),
    training_failed: false,
    training_error: null,
    training_config_sha256:
      preparedTraining.fingerprint,
    retried_after_config_change:
      retryingAfterConfigChange,
    updated_at: nowIso()
  }, config);
  appendAudit('nightly_training_segment_started', {
    run_id: session.run_id,
    container: containerName,
    segment_number: segmentNumber,
    latest_checkpoint: session.latest_checkpoint
  }, config);
  updateStatus({
    state: 'starting',
    phase: 'nightly_training_container_starting',
    current_run_id: session.run_id,
    current_run_kind: 'training',
    current_candidate_type: 'model_adapter',
    current_container: containerName,
    training_resource_mode: 'gpu_training_starting',
    gpu_owner: null,
    last_sandbox_log_file: session.runtime.log_file,
    training_progress: {
      run_id: session.run_id,
      sleep_date: session.sleep_date,
      segment_number: segmentNumber,
      latest_checkpoint: session.latest_checkpoint,
      started_at: next.segment_started_at
    },
    nightly_training_error: null
  }, config);
  return next;
}

function refreshNightlySession(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (!session) return null;
  if (!session.current_container) return session;
  if (containerRunning(session.current_container, config)) return session;

  const checkpoint = latestCheckpoint(session.runtime.adapter_output, config);
  const response = readJson(session.runtime.control_response_file);
  const completedEpoch = completedEpochFromCheckpoint(checkpoint, config);
  const previousCompleted = Number(session.completed_epochs || 0);
  const completedEpochs = Math.max(previousCompleted, completedEpoch);
  const completedNewEpoch = completedEpochs > previousCompleted;

  fs.rmSync(paths(config).currentContainerFile, { force: true });
  return writeSession({
    ...session,
    status: completedNewEpoch
      ? 'epoch_completed_waiting_for_rem'
      : (
          response &&
          response.marker === 'FLOKI_V2_RSI_TRAINING_CHECKPOINT_ACK'
            ? 'checkpointed_without_new_epoch'
            : 'segment_stopped_without_full_epoch'
        ),
    current_container: null,
    completed_epochs: completedEpochs,
    last_completed_epoch: completedNewEpoch
      ? completedEpochs
      : session.last_completed_epoch,
    last_epoch_completed_at: completedNewEpoch
      ? nowIso()
      : session.last_epoch_completed_at || null,
    latest_checkpoint: checkpoint ? checkpoint.dir : session.latest_checkpoint,
    last_checkpoint_at: response && response.acknowledged_at
      ? response.acknowledged_at
      : session.last_checkpoint_at,
    last_checkpoint_response: response || session.last_checkpoint_response || null,
    updated_at: nowIso()
  }, config);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checkpointNightlyTraining(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  let current = refreshNightlySession(session, { config });
  if (!current || !current.current_container) {
    return Object.freeze({
      ok: true,
      checkpointed: false,
      reason: 'no_running_training_container',
      session: current
    });
  }

  const containerName = current.current_container;
  const previousCompletedEpochs = Number(current.completed_epochs || 0);

  if (options.discard_partial_epoch === true) {
    spawnSync(
      config.sandbox_engine,
      ['stop', '--time', String(config.nightly_training_container_stop_timeout_seconds), containerName],
      {
        cwd: config.project_root,
        encoding: 'utf8',
        timeout: Number(config.nightly_training_checkpoint_timeout_ms),
        maxBuffer: config.podman_output_buffer_bytes
      }
    );
    forceRemoveContainer(containerName, config);
    fs.rmSync(current.runtime.control_file, { force: true });
    fs.rmSync(current.runtime.control_response_file, { force: true });
    current = refreshNightlySession(current, { config });

    const retainedEpochs = Number(current.completed_epochs || 0);
    const next = writeSession({
      ...current,
      status: retainedEpochs > 0
        ? 'partial_epoch_discarded_at_wake'
        : 'stopped_without_completed_epoch',
      current_container: null,
      training_failed: false,
      training_error: null,
      partial_epoch_discarded: true,
      partial_epoch_discarded_at: nowIso(),
      updated_at: nowIso()
    }, config);

    appendAudit('nightly_training_partial_epoch_discarded', {
      run_id: next.run_id,
      container: containerName,
      retained_completed_epochs: retainedEpochs,
      reason: options.reason || 'wake_restoration'
    }, config);

    return Object.freeze({
      ok: true,
      checkpointed: false,
      partial_epoch_discarded: true,
      retained_completed_epochs: retainedEpochs,
      session: next
    });
  }

  const requestId = config.nightly_training_checkpoint_request_id_prefix + '-' +
    crypto.randomBytes(config.nightly_training_checkpoint_request_random_bytes).toString('hex');

  atomicJson(current.runtime.control_file, {
    marker: 'FLOKI_V2_RSI_TRAINING_CHECKPOINT_REQUEST',
    action: 'checkpoint_and_stop',
    request_id: requestId,
    reason: options.reason || 'nightly_rem_handoff',
    epoch_boundary_only: options.require_epoch_boundary === true,
    requested_at: nowIso()
  }, config);

  current = writeSession({
    ...current,
    status: options.require_epoch_boundary === true
      ? 'waiting_for_epoch_boundary_before_rem'
      : 'checkpoint_requested',
    checkpoint_request_id: requestId,
    checkpoint_requested_at: nowIso(),
    updated_at: nowIso()
  }, config);

  updateStatus({
    phase: options.require_epoch_boundary === true
      ? 'nightly_training_waiting_for_full_epoch_before_rem'
      : 'nightly_training_checkpoint_before_rem',
    current_container: current.current_container,
    training_progress: {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      segment_number: current.segment_number,
      completed_epochs: previousCompletedEpochs,
      checkpoint_request_id: requestId,
      epoch_boundary_only: options.require_epoch_boundary === true,
      checkpoint_requested_at: current.checkpoint_requested_at
    }
  }, config);

  const timeoutMs = Number(config.nightly_training_checkpoint_timeout_ms);
  const pollMs = Number(config.nightly_training_checkpoint_poll_ms);
  const configuredDeadline = Date.now() + timeoutMs;
  const sleepWindowEndMs = Date.parse(String(options.sleep_window_end || ''));
  const deadline = options.require_epoch_boundary === true && Number.isFinite(sleepWindowEndMs)
    ? Math.max(configuredDeadline, sleepWindowEndMs)
    : configuredDeadline;

  while (Date.now() < deadline) {
    if (!containerRunning(containerName, config)) break;
    await sleep(pollMs);
  }

  let running = containerRunning(containerName, config);
  if (running) {
    spawnSync(
      config.sandbox_engine,
      ['stop', '--time', String(config.nightly_training_container_stop_timeout_seconds), containerName],
      {
        cwd: config.project_root,
        encoding: 'utf8',
        timeout: Math.max(timeoutMs, config.nightly_training_container_stop_timeout_floor_ms),
        maxBuffer: config.podman_output_buffer_bytes
      }
    );
    forceRemoveContainer(containerName, config);
    running = false;
  }

  current = refreshNightlySession(current, { config });
  const response = readJson(current.runtime.control_response_file);
  const completedEpochs = Number(current.completed_epochs || 0);
  const completedFullEpoch = completedEpochs > previousCompletedEpochs;
  const responseAcknowledged = Boolean(response && response.request_id === requestId);
  const successful = options.require_epoch_boundary === true
    ? completedFullEpoch && !running
    : responseAcknowledged && !running;

  const trainingError = successful
    ? null
    : (options.require_epoch_boundary === true
        ? 'training did not reach a full epoch boundary before REM handoff'
        : 'training checkpoint request was not acknowledged before timeout');

  const next = writeSession({
    ...current,
    status: successful ? 'full_epoch_checkpointed_for_rem' : 'checkpoint_failed',
    current_container: null,
    latest_checkpoint: current.latest_checkpoint,
    last_checkpoint_at: response && response.acknowledged_at
      ? response.acknowledged_at
      : current.last_checkpoint_at,
    last_checkpoint_response: response,
    training_failed: successful ? current.training_failed === true : true,
    training_error: trainingError || current.training_error,
    updated_at: nowIso()
  }, config);

  appendAudit(successful
    ? 'nightly_training_full_epoch_checkpoint_completed'
    : 'nightly_training_checkpoint_failed', {
    run_id: current.run_id,
    request_id: requestId,
    checkpoint: next.latest_checkpoint,
    previous_completed_epochs: previousCompletedEpochs,
    completed_epochs: completedEpochs,
    epoch_boundary_only: options.require_epoch_boundary === true,
    error: trainingError
  }, config);

  if (trainingError) {
    updateStatus({
      phase: 'nightly_training_checkpoint_failed',
      current_container: null,
      nightly_training_error: trainingError,
      last_error: trainingError
    }, config);
  }

  return Object.freeze({
    ok: successful,
    checkpointed: successful,
    full_epoch_completed: completedFullEpoch,
    request_id: requestId,
    checkpoint: next.latest_checkpoint,
    error: trainingError,
    session: next
  });
}

function removeControlFiles(session) {
  if (!session || !session.runtime) return;
  fs.rmSync(session.runtime.control_file, { force: true });
  fs.rmSync(session.runtime.control_response_file, { force: true });
}

function completedRemClaimCount(
  session,
  config = loadSelfImprovementConfig()
) {
  if (!session || !session.sleep_date) return 0;
  let store = null;
  try {
    store = readJson(config.training_rem_claim_file, null);
  } catch (_error) {
    return 0;
  }
  const claims = store && store.claims && typeof store.claims === 'object'
    ? Object.values(store.claims)
    : [];
  return claims.filter((claim) => (
    claim &&
    claim.sleep_date === session.sleep_date &&
    claim.status === 'complete' &&
    claim.result &&
    claim.result.ok === true
  )).length;
}

function nightlyCandidateCompletionGate(
  session,
  adapterDir,
  config = loadSelfImprovementConfig()
) {
  const metrics = readJson(
    path.join(adapterDir, config.training_metrics_file_name),
    null
  );
  const epoch = Number(metrics && metrics.epoch || 0);
  const globalStep = Number(metrics && metrics.global_step || 0);
  const minCompletedSteps = Number(
    config && config.nightly_training_min_completed_steps
  );
  const completedEpochs = Number.isFinite(epoch)
    ? Math.floor(epoch + 1e-9)
    : 0;
  const completedRemCycles = completedRemClaimCount(session, config);
  const requiredRemCycles = completedEpochs;
  const contractMet =
    completedEpochs >= 1 &&
    Number.isFinite(minCompletedSteps) &&
    Number.isFinite(globalStep) &&
    globalStep >= minCompletedSteps &&
    completedRemCycles >= requiredRemCycles;
  return Object.freeze({
    ok: contractMet,
    epoch,
    global_step: globalStep,
    min_completed_steps: minCompletedSteps,
    completed_epochs: completedEpochs,
    completed_rem_cycles: completedRemCycles,
    required_rem_cycles: requiredRemCycles,
    reason: contractMet ? null : 'nightly_completion_contract_not_met'
  });
}

function metricsHaveTraining(
  adapterDir,
  config = loadSelfImprovementConfig(),
  session = readNightlySession(config)
) {
  return nightlyCandidateCompletionGate(
    session,
    adapterDir,
    config
  ).ok;
}

function finalizeNightlyTraining(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (!session) return null;
  if (session.finalized === true) return session;
  if (session.aborted === true || session.status === 'aborted') return session;

  removeControlFiles(session);
  if (session.training_failed === true) {
    const next = writeSession({
      ...session,
      active: false,
      finalized: true,
      status: 'completed_without_candidate',
      finalization_reason: 'training_failed',
      finalized_at: nowIso(),
      updated_at: nowIso()
    }, config);
    appendAudit('nightly_training_completed_without_candidate', {
      run_id: session.run_id,
      sleep_date: session.sleep_date,
      reason: 'training_failed',
      error: session.training_error || null
    }, config);
    return next;
  }

  let current = session;
  let plan = current.finalization_plan || null;
  const sourceAdapterDir = current.runtime.adapter_output;
  const plannedAdapterDir = plan && plan.final_adapter_dir || null;
  const artifactDir = plannedAdapterDir && fs.existsSync(plannedAdapterDir)
    ? plannedAdapterDir
    : sourceAdapterDir;

  if (!metricsHaveTraining(artifactDir, config, current)) {
    const next = writeSession({
      ...current,
      active: false,
      finalized: true,
      status: 'completed_without_candidate',
      finalization_reason: 'no_completed_full_epoch',
      finalized_at: nowIso(),
      updated_at: nowIso()
    }, config);
    appendAudit('nightly_training_completed_without_candidate', {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      reason: 'no_completed_full_epoch'
    }, config);
    return next;
  }

  const artifacts = validateTrainingArtifacts(artifactDir, config);
  if (!plan) {
    const version = nextAdapterVersion(config);
    const finalTrainingConfig = readJson(
      current.runtime.training_config_file,
      current.base_training_config
    );
    if (!finalTrainingConfig || !finalTrainingConfig.training) {
      throw new Error('nightly training final configuration is unavailable');
    }
    const lineage = createLineageRecord({
      parent_checkpoint_path: current.hf_master.path,
      parent_checkpoint_identity: current.hf_master.identity,
      dataset_id: current.dataset.dataset_id,
      dataset_hash: current.dataset.records_sha256,
      training_config: finalTrainingConfig,
      seed: finalTrainingConfig.training.seed,
      version,
      metrics: artifacts.metrics
    }, config);
    plan = Object.freeze({
      marker: 'FLOKI_V2_NIGHTLY_TRAINING_FINALIZATION_PLAN',
      adapter_id: lineage.adapter_id,
      final_adapter_dir: path.join(config.adapter_root, lineage.adapter_id),
      lineage,
      created_at: nowIso()
    });
    current = writeSession({
      ...current,
      status: 'finalizing',
      finalization_plan: plan,
      updated_at: nowIso()
    }, config);
  }

  const lineage = plan.lineage;
  if (!lineage || lineage.adapter_id !== plan.adapter_id) {
    throw new Error('nightly training finalization plan has invalid lineage identity');
  }
  const finalAdapterDir = plan.final_adapter_dir;
  fs.mkdirSync(path.dirname(finalAdapterDir), {
    recursive: true,
    mode: 0o700
  });

  const sourceExists = fs.existsSync(sourceAdapterDir);
  const finalExists = fs.existsSync(finalAdapterDir);
  if (sourceExists && finalExists && sourceAdapterDir !== finalAdapterDir) {
    throw new Error(
      'nightly training finalization found both source and destination adapters'
    );
  }
  if (sourceExists && !finalExists) {
    fs.renameSync(sourceAdapterDir, finalAdapterDir);
  } else if (!sourceExists && !finalExists) {
    throw new Error(
      'nightly training adapter artifacts are missing from both source and destination'
    );
  }

  const lineageFile = persistLineage(lineage, config);
  const candidate = writeAdapterCandidate({
    run_id: current.run_id,
    objective: config.nightly_training_candidate_objective,
    container_name: current.current_container || null,
    dataset: current.dataset,
    lineage,
    lineage_file: lineageFile,
    adapter_path: finalAdapterDir,
    metrics: artifacts.metrics
  }, config);

  const next = writeSession({
    ...current,
    active: false,
    finalized: true,
    status: 'candidate_ready_for_review',
    current_container: null,
    candidate_id: candidate.id,
    adapter_id: lineage.adapter_id,
    adapter_path: finalAdapterDir,
    lineage_file: lineageFile,
    finalized_at: nowIso(),
    updated_at: nowIso()
  }, config);
  appendAudit('nightly_training_candidate_created', {
    run_id: current.run_id,
    candidate_id: candidate.id,
    adapter_id: lineage.adapter_id,
    sleep_date: current.sleep_date
  }, config);
  updateStatus({
    state: 'waiting_for_idle',
    phase: 'nightly_training_candidate_ready_for_review',
    current_run_id: null,
    current_container: null,
    latest_candidate_id: candidate.id,
    training_progress: {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      candidate_id: candidate.id,
      adapter_id: lineage.adapter_id,
      metrics: artifacts.metrics,
      completed_at: next.finalized_at
    },
    last_cycle_completed_at: next.finalized_at,
    nightly_training_error: null
  }, config);
  return next;
}

function abortNightlyTrainingSession(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  let current = session || readNightlySession(config);
  const removed = [];
  const failures = [];
  const containers = [];
  const knownHostPids = new Set();
  const execute = options.spawnSync || spawnSync;
  const processIsAlive = options.process_is_alive || ((pid) => {
    try { process.kill(Number(pid), 0); return true; }
    catch (_error) { return false; }
  });
  if (current && current.current_container) containers.push(current.current_container);
  const remActiveFile = path.join(config.training_runtime_root, 'hf-rem-active.json');
  const remActive = readJson(remActiveFile, null);
  if (remActive && remActive.container) containers.push(remActive.container);

  for (const containerName of [...new Set(containers.filter(Boolean))]) {
    try {
      const top = execute(
        config.sandbox_engine,
        ['top', containerName, 'hpid'],
        {
          cwd: config.project_root,
          encoding: 'utf8',
          timeout: config.podman_command_timeout_ms,
          maxBuffer: config.podman_output_buffer_bytes
        }
      );
      if (!top.error && top.status === 0) {
        for (const line of String(top.stdout || '').split(/\r?\n/).slice(1)) {
          const pid = Number(String(line || '').trim().split(/\s+/)[0]);
          if (Number.isInteger(pid) && pid > 0) knownHostPids.add(pid);
        }
      }
      const result = forceRemoveContainer(containerName, config, options);
      removed.push({ container: containerName, ...result });
    } catch (error) {
      failures.push({ container: containerName, error: error.message });
    }
  }
  fs.rmSync(paths(config).currentContainerFile, { force: true });
  fs.rmSync(remActiveFile, { force: true });
  if (current) removeControlFiles(current);

  const verifiedGone = containers.every((containerName) => {
    try { return containerRunning(containerName, config, options) === false; }
    catch (_error) { return false; }
  });
  const verifyTimeoutMs = Math.max(
    1000,
    Number(config.nightly_training_abort_verify_timeout_ms || 10000)
  );
  const verifyDeadline = Date.now() + verifyTimeoutMs;
  let livePids = [...knownHostPids].filter(processIsAlive);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (livePids.length > 0 && Date.now() < verifyDeadline) {
    Atomics.wait(sleeper, 0, 0, 100);
    livePids = [...knownHostPids].filter(processIsAlive);
  }
  const verifiedProcessesGone = livePids.length === 0;

  if (current) {
    current = writeSession({
      ...current,
      active: false,
      finalized: true,
      aborted: true,
      abort_reason: String(options.reason || 'maker_abort_training'),
      aborted_at: nowIso(),
      status: 'aborted',
      current_container: null,
      candidate_id: null,
      adapter_id: null,
      finalization_reason: 'aborted',
      updated_at: nowIso()
    }, config);
  }

  appendAudit('nightly_training_aborted', {
    run_id: current && current.run_id || null,
    reason: String(options.reason || 'maker_abort_training'),
    removed,
    failures,
    verified_workload_gone: verifiedGone && verifiedProcessesGone,
    verified_container_gone: verifiedGone,
    verified_processes_gone: verifiedProcessesGone,
    remaining_host_pids: livePids
  }, config);
  updateStatus({
    state: 'aborted',
    phase: 'nightly_training_aborted',
    current_run_id: null,
    current_container: null,
    current_run_kind: null,
    training_resource_mode: 'aborted',
    gpu_owner: null,
    training_progress: current ? {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      completed_epochs: Number(current.completed_epochs || 0),
      completed_rem_cycles: Number(current.rem_cycles_completed || 0),
      aborted: true,
      aborted_at: current.aborted_at
    } : null,
    last_error: failures.length ? JSON.stringify(failures) : null
  }, config);

  return Object.freeze({
    ok: failures.length === 0 && verifiedGone && verifiedProcessesGone,
    verified: failures.length === 0 && verifiedGone && verifiedProcessesGone,
    marker: failures.length === 0 && verifiedGone && verifiedProcessesGone
      ? 'FLOKI_V2_NIGHTLY_TRAINING_ABORT_VERIFIED'
      : 'FLOKI_V2_NIGHTLY_TRAINING_ABORT_FAILED',
    session: current,
    removed: Object.freeze(removed),
    failures: Object.freeze(failures),
    verified_workload_gone: verifiedGone && verifiedProcessesGone,
    verified_container_gone: verifiedGone,
    verified_processes_gone: verifiedProcessesGone,
    remaining_host_pids: Object.freeze(livePids)
  });
}

function markNightlyTrainingError(session, error, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const message = error && error.stack ? error.stack : String(error && error.message || error);
  const next = session
    ? writeSession({
        ...session,
        status: 'training_failed',
        training_failed: true,
        training_error: message,
        updated_at: nowIso()
      }, config)
    : null;
  appendAudit('nightly_training_failed', {
    run_id: session && session.run_id || null,
    error: message
  }, config);
  updateStatus({
    state: 'failed',
    phase: 'nightly_training_failed',
    nightly_training_error: message,
    last_error: message,
    failure_latched_at: nowIso()
  }, config);
  return next;
}

module.exports = {
  trainingConfigFingerprint,
  nightlyCandidateCompletionGate,
  completedRemClaimCount,
  abortNightlyTrainingSession,
  buildNightlyTrainingConfig,
  checkpointNightlyTraining,
  containerAbsent,
  containerRunning,
  createNightlySession,
  finalizeNightlyTraining,
  forceRemoveContainer,
  latestCheckpoint,
  markNightlyTrainingError,
  readNightlySession,
  refreshNightlySession,
  sessionFile,
  sessionPaths,
  setSessionResourceEntered,
  startNightlyTrainingSegment,
  waitForDetachedContainerLaunch,
  writeSession
};
