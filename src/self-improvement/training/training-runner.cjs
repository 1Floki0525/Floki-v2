
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('../config.cjs');
const { appendAudit, atomicJson, nowIso, paths, refreshPendingReviewCount, updateStatus } = require('../store.cjs');
const { waitForContainerStart } = require('../sandbox.cjs');
const { assertHfMasterReady } = require('./master-preflight.cjs');
const { buildDataset } = require('./dataset-builder.cjs');
const { buildTrainingConfig, buildTrainingRunArgs } = require('./qlora-config.cjs');
const { createLineageRecord, nextAdapterVersion, persistLineage } = require('./lineage.cjs');
const { enterTrainingResource, exitTrainingResource } = require('./runtime-client.cjs');

function sourceFingerprint(config) {
  const hash = crypto.createHash('sha256');
  for (const relative of String(config.training_source_fingerprint_files).split('|').map((item) => item.trim()).filter(Boolean)) {
    hash.update(relative); hash.update('\0');
    hash.update(fs.readFileSync(path.join(config.project_root, relative))); hash.update('\0');
  }
  for (const value of [
    config.training_base_cuda_image,
    config.training_python_packages,
    config.training_container_apt_packages,
    config.training_container_workdir,
    config.training_entrypoint,
    config.training_script_path,
    config.hf_rem_inference_script_path,
    config.training_debian_frontend,
    config.training_pip_no_cache_dir,
    config.training_hf_hub_offline,
    config.training_transformers_offline
  ]) {
    hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function inspectImageLabel(config, label) {
  const result = spawnSync(config.sandbox_engine, ['image', 'inspect', '--format', '{{ index .Config.Labels "' + label + '" }}', config.training_container_image], {
    encoding: 'utf8', timeout: config.podman_command_timeout_ms, maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value && value !== '<no value>' ? value : null;
}

function ensureTrainingImage(config = loadSelfImprovementConfig()) {
  const label = config.training_image_fingerprint_label;
  const expected = sourceFingerprint(config);
  if (inspectImageLabel(config, label) === expected) return Object.freeze({ image: config.training_container_image, rebuilt: false, fingerprint: expected });
  const contextDir = path.resolve(config.project_root, config.training_container_context_dir);
  const result = spawnSync(config.sandbox_engine, [
    'build', '--pull=missing', '--label', label + '=' + expected,
    '--build-arg', 'BASE_CUDA_IMAGE=' + config.training_base_cuda_image,
    '--build-arg', 'PYTHON_PACKAGES=' + config.training_python_packages,
    '--build-arg', 'APT_PACKAGES=' + config.training_container_apt_packages,
    '--build-arg', 'TRAINING_WORKDIR=' + config.training_container_workdir,
    '--build-arg', 'TRAINING_ENTRYPOINT=' + config.training_entrypoint,
    '--build-arg', 'TRAINING_SCRIPT_PATH=' + config.training_script_path,
    '--build-arg', 'REM_INFERENCE_SCRIPT_PATH=' + config.hf_rem_inference_script_path,
    '--build-arg', 'DEBIAN_FRONTEND_VALUE=' + config.training_debian_frontend,
    '--build-arg', 'PIP_NO_CACHE_DIR_VALUE=' + config.training_pip_no_cache_dir,
    '--build-arg', 'HF_HUB_OFFLINE_VALUE=' + config.training_hf_hub_offline,
    '--build-arg', 'TRANSFORMERS_OFFLINE_VALUE=' + config.training_transformers_offline,
    '-t', config.training_container_image, contextDir
  ], { cwd: config.project_root, encoding: 'utf8', timeout: config.image_build_timeout_ms, maxBuffer: config.podman_output_buffer_bytes });
  if (result.status !== 0) throw new Error('training image build failed\n' + String(result.stdout || '') + '\n' + String(result.stderr || ''));
  if (inspectImageLabel(config, label) !== expected) throw new Error('training image fingerprint verification failed after build');
  return Object.freeze({ image: config.training_container_image, rebuilt: true, fingerprint: expected });
}

function newRunId(config = loadSelfImprovementConfig()) {
  return config.training_run_id_prefix + '-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(config.training_run_id_random_bytes).toString('hex');
}

function tail(file, config = loadSelfImprovementConfig()) {
  try { return fs.readFileSync(file, 'utf8').slice(-config.training_log_tail_max_chars); }
  catch (error) { return '[training log unavailable: ' + error.message + ']'; }
}

function containerAbsent(detail) {
  return /(?:no such (?:container|object)|no container with (?:name|id)|does not exist|not found)/i.test(String(detail || ''));
}

function removeTrainingContainer(containerName, config = loadSelfImprovementConfig(), options = {}) {
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
    if (containerAbsent(detail)) {
      return Object.freeze({ ok: true, removed: false, reason: 'already_absent' });
    }
    throw new Error(
      'FLOKI_TRAINING_CONTAINER_CLEANUP_FAILED: ' +
      (detail || 'status=' + String(result.status))
    );
  }
  return Object.freeze({ ok: true, removed: true, reason: null });
}

function waitForTrainingContainerLaunch(child, containerName, config, options = {}) {
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

function validateTrainingArtifacts(adapterDir, config = loadSelfImprovementConfig()) {
  const required = String(config.training_required_artifact_files).split('|').map((item) => item.trim()).filter(Boolean);
  const missing = required.filter((name) => !fs.existsSync(path.join(adapterDir, name)));
  if (missing.length) throw new Error('training container did not produce required adapter artifacts: ' + missing.join(', '));
  const metrics = JSON.parse(fs.readFileSync(path.join(adapterDir, config.training_metrics_file_name), 'utf8'));
  return Object.freeze({ required, metrics });
}

function readExistingTrainingCandidate(dir, input) {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error('training candidate directory exists without manifest: ' + dir);
  }
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(
      'training candidate manifest is unreadable: ' + manifestFile + ': ' +
      error.message
    );
  }
  if (
    existing.id !== input.lineage.adapter_id ||
    existing.adapter_id !== input.lineage.adapter_id ||
    existing.run_id !== input.run_id ||
    existing.candidate_type !== 'model_adapter'
  ) {
    throw new Error('training candidate identity mismatch: ' + dir);
  }
  return Object.freeze(existing);
}

function writeAdapterCandidate(input, config) {
  const candidateId = input.lineage.adapter_id;
  const dir = path.join(config.candidate_root, candidateId);
  if (fs.existsSync(dir)) {
    const existing = readExistingTrainingCandidate(dir, input);
    refreshPendingReviewCount(config);
    return existing;
  }

  fs.mkdirSync(config.candidate_root, { recursive: true, mode: 0o700 });
  const staging = path.join(
    config.candidate_root,
    candidateId + '.tmp-' + String(process.pid) + '-' +
      crypto.randomBytes(config.atomic_temp_random_bytes).toString('hex')
  );
  fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
  const manifest = {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_CANDIDATE',
    id: candidateId,
    candidate_type: 'model_adapter',
    run_kind: 'training',
    status: 'pending_review',
    objective: input.objective || config.training_default_objective,
    summary: config.training_candidate_summary,
    risk_level: config.training_candidate_risk_level,
    created_at: nowIso(),
    updated_at: nowIso(),
    run_id: input.run_id,
    adapter_id: input.lineage.adapter_id,
    adapter_version: input.lineage.version,
    adapter_path: input.adapter_path,
    dataset_id: input.dataset.dataset_id,
    dataset_hash: input.dataset.records_sha256,
    lineage_file: input.lineage_file,
    metrics: input.metrics,
    approval_status: 'pending',
    activation_status: 'inactive'
  };

  try {
    atomicJson(path.join(staging, 'manifest.json'), manifest, config);
    fs.writeFileSync(
      path.join(staging, 'summary.md'),
      '# QLoRA adapter candidate\n\n' +
        'Real QLoRA training completed. This adapter is pending independent ' +
        'evaluation and Maker review. It is not activated.\n'
    );
    fs.writeFileSync(
      path.join(staging, 'architecture-decision.md'),
      '# Adapter lineage\n\n' +
        'The immutable Hugging Face checkpoint remained read-only. Training ' +
        'used QLoRA and produced a separate versioned adapter.\n'
    );
    fs.writeFileSync(path.join(staging, 'changes.diff'), '');
    fs.writeFileSync(path.join(staging, 'research-sources.json'), '[]\n');
    fs.writeFileSync(
      path.join(staging, 'test-results.json'),
      JSON.stringify([
        { name: 'training_container', ok: true, metrics: input.metrics }
      ], null, 2) + '\n'
    );
    fs.writeFileSync(path.join(staging, 'benchmark-results.json'), '[]\n');
    fs.writeFileSync(
      path.join(staging, 'command-audit.jsonl'),
      JSON.stringify({
        type: 'training_complete',
        created_at: nowIso(),
        run_id: input.run_id,
        container: input.container_name,
        adapter_id: input.lineage.adapter_id
      }) + '\n'
    );
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  refreshPendingReviewCount(config);
  return Object.freeze(manifest);
}

async function runTrainingCycle(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (config.training_enabled !== true) throw new Error('training is disabled');
  if (options.force === true && config.manual_training_enabled !== true) throw new Error('manual training is disabled');
  const runId = options.run_id || newRunId(config);
  const objective = String(options.objective || '').trim();
  const runtimeRoot = path.join(config.training_runtime_root, runId);
  const adapterTemp = path.join(runtimeRoot, config.training_adapter_output_dir_name);
  const logFile = path.join(runtimeRoot, config.training_log_file_name);
  const trainingConfigFile = path.join(runtimeRoot, config.training_config_file_name);
  const containerName = config.training_container_name_prefix + '-' + runId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  fs.mkdirSync(adapterTemp, { recursive: true, mode: 0o700 });
  const preflight = assertHfMasterReady(config);
  const dataset = buildDataset({ config });
  const trainingConfig = buildTrainingConfig({ config });
  fs.writeFileSync(trainingConfigFile, JSON.stringify(trainingConfig, null, 2) + '\n', { mode: 0o600 });
  const image = ensureTrainingImage(config);
  updateStatus({ state: 'starting', phase: 'training_resource_transition', current_run_id: runId, current_run_kind: 'training', current_candidate_type: 'model_adapter', current_objective: objective || config.training_status_objective, current_container: null, training_resource_mode: 'entering', training_progress: { run_id: runId, dataset_id: dataset.dataset_id, container: containerName, image_rebuilt: image.rebuilt, started_at: nowIso() }, last_error: null }, config);
  let entered = false;
  let logDescriptor = null;
  let trainingSucceeded = false;
  let primaryError = null;
  try {
    const resource = await enterTrainingResource(runId, config);
    entered = true;
    appendAudit('training_resource_mode_entered', { run_id: runId, resource }, config);
    const args = buildTrainingRunArgs({ config, containerName, hfMasterPath: preflight.path, datasetDir: dataset.root, adapterOutDir: adapterTemp, trainingConfigFile });
    logDescriptor = fs.openSync(logFile, 'a', 0o600);
    atomicJson(paths(config).currentContainerFile, { marker: 'FLOKI_V2_SELF_IMPROVEMENT_CURRENT_CONTAINER', run_id: runId, kind: 'training', candidate_type: 'model_adapter', name: containerName, created_at: nowIso(), stop_requested_at: null, stop_reason: null }, config);
    const child = spawn(config.sandbox_engine, args, { cwd: config.project_root, env: process.env, stdio: ['ignore', logDescriptor, logDescriptor] });
    await waitForTrainingContainerLaunch(child, containerName, config);
    const acknowledgedAt = nowIso();
    updateStatus({ state: 'training', phase: 'qlora_container_running', current_run_id: runId, current_run_kind: 'training', current_candidate_type: 'model_adapter', current_container: containerName, manual_run_pending: false, manual_run_request_id: options.manual_request_id || null, manual_run_acknowledged_at: options.manual_request_id ? acknowledgedAt : null, training_resource_mode: 'active', gpu_owner: 'hf_training', last_sandbox_log_file: logFile }, config);
    appendAudit('training_container_started', { run_id: runId, container: containerName, manual_request_id: options.manual_request_id || null, acknowledged_at: acknowledgedAt }, config);
    const exit = await new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) => resolve({ code: -1, signal: null, error }));
    });
    if (exit.code !== 0) throw new Error('training container exited with status ' + String(exit.code) + (exit.signal ? ' signal ' + exit.signal : '') + '\n' + tail(logFile, config));
    const artifacts = validateTrainingArtifacts(adapterTemp, config);
    const version = nextAdapterVersion(config);
    const lineage = createLineageRecord({ parent_checkpoint_path: preflight.path, parent_checkpoint_identity: path.basename(preflight.path), dataset_id: dataset.dataset_id, dataset_hash: dataset.records_sha256, training_config: trainingConfig, seed: trainingConfig.training.seed, version, metrics: artifacts.metrics }, config);
    const finalAdapterDir = path.join(config.adapter_root, lineage.adapter_id);
    fs.mkdirSync(path.dirname(finalAdapterDir), { recursive: true, mode: 0o700 });
    if (fs.existsSync(finalAdapterDir)) {
      throw new Error('training adapter destination already exists: ' + finalAdapterDir);
    }
    fs.renameSync(adapterTemp, finalAdapterDir);
    let candidate;
    let lineageFile;
    try {
      lineageFile = persistLineage(lineage, config);
      candidate = writeAdapterCandidate({ run_id: runId, objective, container_name: containerName, dataset, lineage, lineage_file: lineageFile, adapter_path: finalAdapterDir, metrics: artifacts.metrics }, config);
    } catch (error) {
      const candidateManifest = path.join(config.candidate_root, lineage.adapter_id, 'manifest.json');
      if (!fs.existsSync(candidateManifest) && fs.existsSync(finalAdapterDir) && !fs.existsSync(adapterTemp)) {
        fs.renameSync(finalAdapterDir, adapterTemp);
      }
      throw error;
    }
    trainingSucceeded = true;
    updateStatus({ state: 'waiting_for_idle', phase: 'training_candidate_ready_for_review', current_run_id: null, current_container: null, latest_candidate_id: candidate.id, training_resource_mode: 'restoring', training_progress: { run_id: runId, completed_at: nowIso(), adapter_id: lineage.adapter_id, candidate_id: candidate.id, metrics: artifacts.metrics }, last_cycle_completed_at: nowIso(), last_error: null }, config);
    appendAudit('training_candidate_created', { run_id: runId, candidate_id: candidate.id, adapter_id: lineage.adapter_id, dataset_id: dataset.dataset_id }, config);
    return { ok: true, candidate_id: candidate.id, adapter_id: lineage.adapter_id, run_id: runId, container: containerName, metrics: artifacts.metrics };
  } catch (error) {
    primaryError = error;
    updateStatus({ state: 'failed', phase: 'training_failed', current_run_id: null, current_container: null, training_resource_mode: entered ? 'restoring_after_failure' : 'entry_failed', last_error: error.stack || error.message, failure_latched_at: nowIso(), last_sandbox_log_file: logFile }, config);
    appendAudit('training_failed', { run_id: runId, error: error.stack || error.message }, config);
    throw error;
  } finally {
    const cleanupFailures = [];
    try {
      fs.rmSync(paths(config).currentContainerFile, { force: true });
    } catch (error) {
      cleanupFailures.push({ step: 'remove_current_container_state', error: error.message });
    }
    if (logDescriptor !== null) {
      try {
        fs.closeSync(logDescriptor);
      } catch (error) {
        cleanupFailures.push({ step: 'close_training_log', error: error.message });
      }
    }
    try {
      const cleanup = removeTrainingContainer(containerName, config);
      appendAudit('training_container_cleanup', { run_id: runId, container: containerName, cleanup }, config);
    } catch (error) {
      cleanupFailures.push({ step: 'remove_training_container', error: error.message });
    }

    let restoration = null;
    if (entered) {
      try {
        restoration = await exitTrainingResource(trainingSucceeded ? 'training_complete' : 'training_failure', config);
        appendAudit('training_resource_mode_exited', { run_id: runId, restoration }, config);
        if (!restoration || restoration.ok !== true) {
          cleanupFailures.push({
            step: 'restore_runtime_resources',
            error: 'runtime restoration failed after training: ' +
              JSON.stringify(restoration && (restoration.failures || restoration))
          });
        }
      } catch (error) {
        cleanupFailures.push({ step: 'restore_runtime_resources', error: error.message });
      }
    }

    if (cleanupFailures.length > 0) {
      const message = 'training cleanup/restoration failures: ' + JSON.stringify(cleanupFailures);
      appendAudit('training_cleanup_failed', { run_id: runId, failures: cleanupFailures }, config);
      updateStatus({
        state: 'failed',
        phase: 'training_restoration_failed',
        current_run_id: null,
        current_container: null,
        training_resource_mode: 'failed',
        restoration_status: restoration,
        last_error: message,
        failure_latched_at: nowIso()
      }, config);
      if (primaryError) {
        primaryError.message += '\n' + message;
      } else {
        throw new Error(message);
      }
    } else if (entered) {
      updateStatus({
        training_resource_mode: 'idle',
        gpu_owner: null,
        restoration_status: restoration
      }, config);
    }
  }
}

module.exports = {
  containerAbsent,
  ensureTrainingImage,
  newRunId,
  readExistingTrainingCandidate,
  removeTrainingContainer,
  runTrainingCycle,
  sourceFingerprint,
  validateTrainingArtifacts,
  waitForTrainingContainerLaunch,
  writeAdapterCandidate
};
