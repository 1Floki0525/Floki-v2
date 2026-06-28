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

function containerRunning(containerName, config = loadSelfImprovementConfig()) {
  if (!containerName) return false;
  const result = spawnSync(
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
  return Object.freeze({
    ...baseConfig,
    training: Object.freeze({
      ...baseConfig.training,
      max_steps: Number(config.nightly_training_max_steps),
      save_total_limit: Number(config.nightly_training_save_total_limit)
    }),
    scheduler: Object.freeze({
      mode: config.nightly_training_mode,
      segment_number: Number(session.segment_number || 0) + 1,
      resume_from_checkpoint: config.nightly_training_resume_policy,
      control_file: control.control_file,
      control_response_file: control.control_response_file,
      checkpoint_before_rem: config.training_checkpoint_before_rem === true
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
    existing.sleep_date === sleepWindow.sleep_date &&
    existing.finalized !== true
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
    current_container: null,
    segment_number: 0,
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
    state: 'training',
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

function writeTrainingConfig(session, config = loadSelfImprovementConfig()) {
  const nextConfig = buildNightlyTrainingConfig(
    session.base_training_config,
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
  return nextConfig;
}

async function startNightlyTrainingSegment(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (!session || session.active !== true || session.finalized === true) {
    return session;
  }
  if (session.training_failed === true && options.retry_failed !== true) {
    return session;
  }
  if (session.current_container && containerRunning(session.current_container, config)) {
    return session;
  }
  if (session.resource_entered !== true) {
    throw new Error('nightly training resource mode is not active');
  }

  fs.rmSync(session.runtime.control_file, { force: true });
  fs.rmSync(session.runtime.control_response_file, { force: true });
  const trainingConfig = writeTrainingConfig(session, config);
  const segmentNumber = Number(trainingConfig.scheduler.segment_number);
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
    updated_at: nowIso()
  }, config);
  appendAudit('nightly_training_segment_started', {
    run_id: session.run_id,
    container: containerName,
    segment_number: segmentNumber,
    latest_checkpoint: session.latest_checkpoint
  }, config);
  updateStatus({
    state: 'training',
    phase: 'nightly_training_segment_running',
    current_run_id: session.run_id,
    current_run_kind: 'training',
    current_candidate_type: 'model_adapter',
    current_container: containerName,
    training_resource_mode: 'active',
    gpu_owner: 'hf_training',
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
  fs.rmSync(paths(config).currentContainerFile, { force: true });
  return writeSession({
    ...session,
    status: response && response.marker === 'FLOKI_V2_RSI_TRAINING_CHECKPOINT_ACK'
      ? 'checkpointed'
      : 'segment_stopped',
    current_container: null,
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

  const requestId = config.nightly_training_checkpoint_request_id_prefix + '-' + crypto.randomBytes(config.nightly_training_checkpoint_request_random_bytes).toString('hex');
  atomicJson(current.runtime.control_file, {
    marker: 'FLOKI_V2_RSI_TRAINING_CHECKPOINT_REQUEST',
    action: 'checkpoint_and_stop',
    request_id: requestId,
    reason: options.reason || 'nightly_rem_handoff',
    requested_at: nowIso()
  }, config);

  current = writeSession({
    ...current,
    status: 'checkpoint_requested',
    checkpoint_request_id: requestId,
    checkpoint_requested_at: nowIso(),
    updated_at: nowIso()
  }, config);
  updateStatus({
    phase: 'nightly_training_checkpoint_before_rem',
    current_container: current.current_container,
    training_progress: {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      segment_number: current.segment_number,
      checkpoint_request_id: requestId,
      checkpoint_requested_at: current.checkpoint_requested_at
    }
  }, config);

  const timeoutMs = Number(config.nightly_training_checkpoint_timeout_ms);
  const pollMs = Number(config.nightly_training_checkpoint_poll_ms);
  const deadline = Date.now() + timeoutMs;
  let response = null;

  while (Date.now() < deadline) {
    response = readJson(current.runtime.control_response_file);
    const acknowledged = response && response.request_id === requestId;
    const running = containerRunning(current.current_container, config);
    if (acknowledged && !running) break;
    await sleep(pollMs);
  }

  response = readJson(current.runtime.control_response_file);
  const acknowledged = Boolean(response && response.request_id === requestId);
  if (!acknowledged || containerRunning(current.current_container, config)) {
    spawnSync(config.sandbox_engine, ['stop', '--time', String(config.nightly_training_container_stop_timeout_seconds), current.current_container], {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: Math.max(timeoutMs, config.nightly_training_container_stop_timeout_floor_ms),
      maxBuffer: config.podman_output_buffer_bytes
    });
    forceRemoveContainer(current.current_container, config);
  }

  const checkpoint = latestCheckpoint(current.runtime.adapter_output, config);
  fs.rmSync(paths(config).currentContainerFile, { force: true });
  const trainingError = acknowledged
    ? null
    : 'training checkpoint request was not acknowledged before timeout';
  const next = writeSession({
    ...current,
    status: acknowledged ? 'checkpointed' : 'checkpoint_failed',
    current_container: null,
    latest_checkpoint: checkpoint ? checkpoint.dir : current.latest_checkpoint,
    last_checkpoint_at: response && response.acknowledged_at
      ? response.acknowledged_at
      : nowIso(),
    last_checkpoint_response: response,
    training_failed: acknowledged ? current.training_failed === true : true,
    training_error: trainingError || current.training_error,
    updated_at: nowIso()
  }, config);

  appendAudit(acknowledged
    ? 'nightly_training_checkpoint_completed'
    : 'nightly_training_checkpoint_failed', {
    run_id: current.run_id,
    request_id: requestId,
    checkpoint: next.latest_checkpoint,
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
    ok: acknowledged,
    checkpointed: acknowledged,
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

function metricsHaveTraining(adapterDir, config = loadSelfImprovementConfig()) {
  const metrics = readJson(path.join(adapterDir, config.training_metrics_file_name));
  return Boolean(metrics && Number(metrics.global_step || 0) >= config.nightly_training_min_completed_steps);
}

function finalizeNightlyTraining(session, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (!session) return null;
  if (session.finalized === true) return session;

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

  if (!metricsHaveTraining(artifactDir, config)) {
    const next = writeSession({
      ...current,
      active: false,
      finalized: true,
      status: 'completed_without_candidate',
      finalization_reason: 'no_completed_training_step',
      finalized_at: nowIso(),
      updated_at: nowIso()
    }, config);
    appendAudit('nightly_training_completed_without_candidate', {
      run_id: current.run_id,
      sleep_date: current.sleep_date,
      reason: 'no_completed_training_step'
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
