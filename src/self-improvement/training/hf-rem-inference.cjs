'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadSelfImprovementConfig } = require('../config.cjs');
const { atomicJson, nowIso } = require('../store.cjs');
const { assertHfMasterReady } = require('./master-preflight.cjs');
const { listAdapters } = require('./lineage.cjs');
const { ensureTrainingImage } = require('./training-runner.cjs');
const { splitPipeList } = require('./gpu-ownership.cjs');

function readResponseJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      'FLOKI_HF_REM_RESPONSE_READ_FAILED: ' + file + ': ' +
      (error && error.message ? error.message : String(error))
    );
  }
}

function resolveApprovedInferenceSource(config = loadSelfImprovementConfig()) {
  const master = assertHfMasterReady(config);
  const approved = listAdapters(config)
    .filter((adapter) => adapter.approval_status === 'approved')
    .sort((left, right) => Number(left.version_number || 0) - Number(right.version_number || 0));
  const active = approved.filter((adapter) => adapter.activation_status === 'active');
  const selected = (active.length ? active : approved).slice(-1)[0] || null;

  if (!selected) {
    return Object.freeze({
      source_kind: 'hf_master',
      model_identity: config.hf_rem_master_identity,
      base_model_path: master.path,
      adapter_path: null,
      adapter_id: null,
      version: null
    });
  }

  const adapterPath = path.join(config.adapter_root, selected.adapter_id);
  for (const required of String(config.hf_rem_required_adapter_files).split('|').map((item) => item.trim()).filter(Boolean)) {
    if (!fs.existsSync(path.join(adapterPath, required))) {
      throw new Error('approved adapter is missing ' + required + ': ' + selected.adapter_id);
    }
  }

  return Object.freeze({
    source_kind: selected.activation_status === 'active'
      ? 'active_approved_adapter'
      : 'approved_adapter',
    model_identity: config.hf_rem_model_identity_prefix + selected.adapter_id,
    base_model_path: master.path,
    adapter_path: adapterPath,
    adapter_id: selected.adapter_id,
    version: selected.version || null
  });
}

function buildRemContainerArgs(input, config = loadSelfImprovementConfig()) {
  const args = [
    'run',
    '--rm',
    '--name', input.container_name,
    ...splitPipeList(config.training_gpu_device_args),
    '--security-opt=' + config.security_opt,
    '--pids-limit', String(config.training_pids_limit),
    '--memory', String(config.training_memory_limit),
    '--cpus', String(config.training_cpu_limit),
    '--network', config.hf_rem_network_mode,
    '--workdir', config.training_container_workdir,
    '-v', input.source.base_model_path + ':' + config.training_hf_master_mount_path + ':' + config.self_context_mount_options,
    '-v', input.runtime_dir + ':' + config.hf_rem_runtime_mount_path + ':' + config.outbox_mount_options,
    '-e', 'FLOKI_REM_REQUEST_FILE=' + path.posix.join(config.hf_rem_runtime_mount_path, config.hf_rem_request_file_name),
    '-e', 'FLOKI_REM_RESPONSE_FILE=' + path.posix.join(config.hf_rem_runtime_mount_path, config.hf_rem_response_file_name)
  ];

  if (input.source.adapter_path) {
    args.push(
      '-v',
      input.source.adapter_path + ':' + config.hf_rem_adapter_mount_path + ':' + config.self_context_mount_options
    );
  }

  args.push(
    '--entrypoint',
    config.hf_rem_entrypoint,
    config.training_container_image,
    config.hf_rem_inference_script_path
  );
  return args;
}

function containerAbsent(detail) {
  return /(?:no such (?:container|object)|no container with (?:name|id)|does not exist|not found)/i.test(String(detail || ''));
}

function forceRemove(containerName, config, options = {}) {
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
      'FLOKI_HF_REM_CONTAINER_CLEANUP_FAILED: ' +
      (detail || 'status=' + String(result.status))
    );
  }
  return Object.freeze({ ok: true, removed: true, reason: null });
}

function runHfRemGeneration(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (config.hf_rem_inference_endpoint !== 'container://one-shot') {
    throw new Error('hf_rem_inference_endpoint must be container://one-shot');
  }
  const source = options.source || resolveApprovedInferenceSource(config);
  ensureTrainingImage(config);

  const remId = String(options.rem_id || (
    config.hf_rem_id_prefix + '-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(config.hf_rem_id_random_bytes).toString('hex')
  )).replace(/[^a-zA-Z0-9_.-]/g, '-');
  const runtimeDir = path.join(config.training_runtime_root, config.hf_rem_runtime_subdir, remId);
  const requestFile = path.join(runtimeDir, config.hf_rem_request_file_name);
  const responseFile = path.join(runtimeDir, config.hf_rem_response_file_name);
  const logFile = path.join(runtimeDir, config.hf_rem_log_file_name);
  const containerName = config.hf_rem_container_name_prefix + '-' + remId;
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const request = {
    marker: 'FLOKI_V2_HF_REM_REQUEST',
    created_at: nowIso(),
    prompt: String(options.prompt || ''),
    system: String(options.system || ''),
    schema: options.schema || null,
    base_model_path: config.training_hf_master_mount_path,
    adapter_path: source.adapter_path ? config.hf_rem_adapter_mount_path : null,
    model_identity: source.model_identity,
    temperature: Number(config.hf_rem_temperature),
    top_p: Number(config.hf_rem_top_p),
    max_new_tokens: Number(config.hf_rem_max_new_tokens),
    repetition_penalty: Number(config.hf_rem_repetition_penalty),
    quantization_type: config.qlora_bnb_4bit_quant_type,
    compute_dtype: config.qlora_bnb_4bit_compute_dtype,
    use_double_quant: config.qlora_bnb_4bit_use_double_quant === true,
    tokenizer_use_fast: config.hf_rem_tokenizer_use_fast === true,
    device_map: config.hf_rem_device_map,
    do_sample: config.hf_rem_do_sample === true,
    provider: config.nightly_rem_provider,
    approved_lineage: {
      source_kind: source.source_kind,
      adapter_id: source.adapter_id,
      version: source.version
    }
  };
  atomicJson(requestFile, request, config);

  const args = buildRemContainerArgs({
    container_name: containerName,
    runtime_dir: runtimeDir,
    source
  }, config);

  let result;
  let primaryError = null;
  try {
    result = spawnSync(config.sandbox_engine, args, {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: Number(config.hf_rem_inference_timeout_ms),
      maxBuffer: config.podman_output_buffer_bytes
    });
    fs.writeFileSync(
      logFile,
      String(result.stdout || '') + String(result.stderr || ''),
      { mode: 0o600 }
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        'FLOKI_HF_REM_CONTAINER_FAILED: status=' + String(result.status) + '\n' +
        String(result.stdout || '') + '\n' + String(result.stderr || '')
      );
    }

    const response = readResponseJson(responseFile);
    if (
      !response ||
      response.marker !== 'FLOKI_V2_HF_REM_INFERENCE_PASS' ||
      !response.response_json
    ) {
      throw new Error('FLOKI_HF_REM_RESPONSE_INVALID: ' + responseFile);
    }

    return Object.freeze({
      model: response.model || source.model_identity,
      response_json: response.response_json,
      raw_stats: Object.freeze({
        ...(response.raw_stats || {}),
        provider: config.nightly_rem_provider,
        approved_lineage_only: true,
        source_kind: source.source_kind,
        adapter_id: source.adapter_id,
        version: source.version,
        runtime_dir: runtimeDir,
        log_file: logFile
      })
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      forceRemove(containerName, config);
    } catch (cleanupError) {
      if (primaryError) {
        primaryError.message += '\n' + cleanupError.message;
      } else {
        throw cleanupError;
      }
    }
  }
}

module.exports = {
  buildRemContainerArgs,
  containerAbsent,
  forceRemove,
  resolveApprovedInferenceSource,
  readResponseJson,
  runHfRemGeneration
};
