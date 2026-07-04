
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadSelfImprovementConfig } = require('../config.cjs');
const gpuOwnership = require('./gpu-ownership.cjs');

function execute(command, args, config = {}, options = {}) {
  const runner = options.spawnSync || spawnSync;
  const executable = typeof command === 'string' ? command.trim() : '';
  if (!executable) {
    return Object.freeze({
      status: -1,
      stdout: '',
      stderr: '',
      error: new Error('training observation command is not configured')
    });
  }
  try {
    const result = runner(executable, args, {
      cwd: typeof config.project_root === 'string' && config.project_root.trim()
        ? config.project_root
        : process.cwd(),
      encoding: 'utf8',
      timeout: Number(config.podman_command_timeout_ms || 30000),
      maxBuffer: Number(config.podman_output_buffer_bytes || 4 * 1024 * 1024)
    });
    return Object.freeze({
      status: Number.isInteger(result && result.status) ? result.status : -1,
      stdout: String(result && result.stdout || ''),
      stderr: String(result && result.stderr || ''),
      error: result && result.error || null
    });
  } catch (error) {
    return Object.freeze({
      status: -1,
      stdout: '',
      stderr: '',
      error
    });
  }
}

function parsePodmanInspect(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '[]'));
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const state = row && row.State || {};
    return Object.freeze({
      exists: Boolean(row),
      running: state.Running === true,
      pid: Number(state.Pid || 0),
      status: state.Status || null,
      exit_code: Number(state.ExitCode || 0)
    });
  } catch (_error) {
    return Object.freeze({ exists: false, running: false, pid: 0, status: null, exit_code: 0 });
  }
}

function parsePodmanTop(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
    .map((line) => {
      const parts = line.split(/\s+/, 4);
      return Object.freeze({
        host_pid: Number(parts[0] || 0),
        pid: Number(parts[1] || 0),
        command: String(parts[2] || ''),
        args: String(parts[3] || '')
      });
    })
    .filter((row) => Number.isInteger(row.host_pid) && row.host_pid > 0);
}

function parseNvidiaRows(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      return Object.freeze({
        pid: Number(parts[0] || 0),
        process_name: parts[1] || '',
        used_memory_mb: Number(String(parts[2] || '0').replace(/[^0-9.]/g, '')) || 0
      });
    })
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

function readActiveRem(config = {}) {
  const runtimeRoot = typeof config.training_runtime_root === 'string'
    ? config.training_runtime_root.trim()
    : '';
  if (!runtimeRoot) return null;
  const file = path.join(runtimeRoot, 'hf-rem-active.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function inspectContainer(name, config, options = {}) {
  if (!name) return Object.freeze({ name: null, exists: false, running: false, pid: 0, processes: [] });
  const inspected = execute(config.sandbox_engine, ['inspect', name], config, options);
  if (inspected.error || inspected.status !== 0) {
    const detail = String(
      inspected.error && inspected.error.message ||
      inspected.stderr || inspected.stdout || ''
    ).trim();
    const absent = /(?:no such (?:container|object)|no container with (?:name|id)|does not exist|not found)/i.test(detail);
    return Object.freeze({
      name,
      exists: false,
      running: false,
      pid: 0,
      processes: [],
      error: absent ? null : (detail || 'container inspection failed')
    });
  }
  const state = parsePodmanInspect(inspected.stdout);
  let processes = [];
  if (state.running) {
    const top = execute(config.sandbox_engine, ['top', name, 'hpid', 'pid', 'comm', 'args'], config, options);
    if (!top.error && top.status === 0) processes = parsePodmanTop(top.stdout);
  }
  return Object.freeze({ name, ...state, processes: Object.freeze(processes) });
}

function readLogReality(file, nowMs, freshnessMs) {
  if (!file) return Object.freeze({ file: null, exists: false, size: 0, mtime_ms: 0, advancing: false });
  try {
    const stat = fs.statSync(file);
    return Object.freeze({
      file,
      exists: stat.isFile(),
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      advancing: stat.isFile() && stat.size > 0 && nowMs - stat.mtimeMs <= freshnessMs
    });
  } catch (_error) {
    return Object.freeze({ file, exists: false, size: 0, mtime_ms: 0, advancing: false });
  }
}

function queryNvidia(config, options = {}) {
  if (typeof options.query_nvidia === 'function') return options.query_nvidia();
  const command = String(config.training_gpu_process_query_command || 'nvidia-smi');
  const args = String(config.training_gpu_process_query_args || '--query-compute-apps=pid,process_name,used_gpu_memory|--format=csv,noheader,nounits')
    .split('|').map((value) => value.trim()).filter(Boolean);
  const result = execute(command, args, config, options);
  if (result.error || result.status !== 0) {
    return Object.freeze({ ok: false, rows: Object.freeze([]), error: String(result.error && result.error.message || result.stderr || result.stdout || '').trim() });
  }
  return Object.freeze({ ok: true, rows: Object.freeze(parseNvidiaRows(result.stdout)), error: null });
}

function deriveTrainingTruth(input = {}) {
  const session = input.session || null;
  const trainingContainer = input.training_container || { exists: false, running: false, processes: [] };
  const remContainer = input.rem_container || { exists: false, running: false, processes: [] };
  const nvidia = input.nvidia || { ok: false, rows: [] };
  const log = input.log || { exists: false, advancing: false };
  const lockOwner = input.lock_owner || null;
  const observationErrors = [
    trainingContainer.error,
    remContainer.error,
    nvidia.error,
    input.ownership_error
  ].filter(Boolean);
  const observationComplete = observationErrors.length === 0 && nvidia.ok === true;
  const activeContainer = remContainer.running ? remContainer : trainingContainer;
  const containerPids = new Set((activeContainer.processes || []).map((row) => Number(row.host_pid)).filter(Boolean));
  if (activeContainer.pid) containerPids.add(Number(activeContainer.pid));
  const expectedGpuRows = (nvidia.rows || []).filter((row) => (
    containerPids.has(Number(row.pid)) &&
    /(?:train_qlora|rem_inference|python)/i.test(String(row.process_name || '')) &&
    Number(row.used_memory_mb || 0) > 0
  ));
  const expectedProcessAlive = (activeContainer.processes || []).some((row) =>
    /(?:train_qlora|rem_inference|python)/i.test(String(row.command || '') + ' ' + String(row.args || ''))
  );
  const remActive = Boolean(
    session && session.aborted !== true && remContainer.exists && remContainer.running &&
    expectedProcessAlive && expectedGpuRows.length > 0 && log.advancing === true
  );
  const trainingActive = Boolean(
    session && session.aborted !== true && trainingContainer.exists && trainingContainer.running &&
    expectedProcessAlive && expectedGpuRows.length > 0 && log.advancing === true
  );
  const observedOwner = remActive ? 'hf_rem_inference' : trainingActive ? 'hf_training' : null;
  const nowMs = Number(input.now_ms || Date.now());
  const startupGraceMs = Math.max(10000, Number(input.startup_grace_ms || 120000));
  const sessionUpdatedMs = Date.parse(String(
    session && (session.updated_at || session.started_at || session.created_at) || ''
  ));
  const reservationFresh = Number.isFinite(sessionUpdatedMs) &&
    nowMs - sessionUpdatedMs <= startupGraceMs;
  const ownerReservedForHandoff = Boolean(
    ['hf_training', 'hf_rem_inference'].includes(lockOwner) &&
    session && session.active === true && session.finalized !== true &&
    session.aborted !== true && session.training_failed !== true &&
    session.resource_entered === true && reservationFresh
  );
  const staleOwner = observationComplete &&
    ['hf_training', 'hf_rem_inference'].includes(lockOwner) &&
    observedOwner !== lockOwner && !ownerReservedForHandoff;
  let phase = 'inactive';
  if (session && session.aborted === true) phase = 'aborted';
  else if (observationErrors.length > 0 && session && session.active === true) phase = 'observation_failed';
  else if (session && session.training_failed === true) phase = 'failed';
  else if (remActive) phase = 'rem_inference';
  else if (trainingActive) phase = 'training';
  else if (activeContainer.running) phase = 'starting';
  else if (session && session.active === true && session.finalized !== true) {
    const completed = Number(session.completed_epochs || 0);
    const rems = Number(session.rem_cycles_completed || 0);
    phase = completed > rems ? 'waiting_for_rem' : session.status === 'prepared' ? 'prepared' : 'waiting';
  }
  return Object.freeze({
    container_exists: activeContainer.exists === true,
    container_running: activeContainer.running === true,
    training_container_running: trainingContainer.running === true,
    rem_container_running: remContainer.running === true,
    process_alive: expectedProcessAlive,
    observation_complete: observationComplete,
    observation_errors: Object.freeze(observationErrors),
    observation_error: observationErrors.length > 0
      ? observationErrors.join('; ')
      : null,
    nvidia_query_ok: nvidia.ok === true,
    gpu_compute_process: expectedGpuRows.length > 0,
    expected_hf_gpu_rows: Object.freeze(expectedGpuRows),
    log_exists: log.exists === true,
    log_advancing: log.advancing === true,
    live_training: trainingActive,
    live_rem: remActive,
    observed_gpu_owner: observedOwner,
    persisted_gpu_owner: lockOwner,
    stale_gpu_owner: staleOwner,
    gpu_owner_reserved_for_start_or_handoff: ownerReservedForHandoff,
    phase,
    resource_mode: observedOwner || phase,
    active_hf_model: observedOwner !== null
  });
}

function observeTrainingReality(options = {}) {
  const config = options.config && typeof options.config === 'object'
    ? options.config
    : loadSelfImprovementConfig();
  const session = options.session || null;
  const rem = Object.prototype.hasOwnProperty.call(options, 'rem_activity')
    ? options.rem_activity
    : readActiveRem(config);
  const trainingName = session && session.current_container || null;
  const remName = rem && rem.container || null;
  const trainingContainer = Object.prototype.hasOwnProperty.call(options, 'training_container')
    ? options.training_container
    : inspectContainer(trainingName, config, options);
  const remContainer = Object.prototype.hasOwnProperty.call(options, 'rem_container')
    ? options.rem_container
    : inspectContainer(remName, config, options);
  const observableContainer = remContainer && remContainer.running === true
    ? remContainer
    : trainingContainer;
  const nvidia = Object.prototype.hasOwnProperty.call(options, 'nvidia')
    ? options.nvidia
    : observableContainer && (
        observableContainer.exists === true ||
        observableContainer.running === true
      )
      ? queryNvidia(config, options)
      : Object.freeze({
          ok: true,
          rows: Object.freeze([]),
          error: null,
          skipped: true,
          reason: 'no_observable_training_container'
        });
  const activeLog = remContainer && remContainer.running
    ? rem && rem.log_file
    : session && (
        session.runtime && session.runtime.log_file ||
        session.log_file ||
        session.current_log_file ||
        session.latest_training_log_file
      );
  const freshnessMs = Math.max(
    5000,
    Number(config.training_observation_log_fresh_ms || 45000)
  );
  const log = Object.prototype.hasOwnProperty.call(options, 'log')
    ? options.log
    : readLogReality(
        activeLog,
        Number(options.now_ms || Date.now()),
        freshnessMs
      );
  let lockOwner = null;
  let ownershipError = null;
  if (Object.prototype.hasOwnProperty.call(options, 'lock_owner')) {
    lockOwner = options.lock_owner;
  } else if (
    typeof config.gpu_ownership_lock_file === 'string' &&
    config.gpu_ownership_lock_file.trim()
  ) {
    try {
      lockOwner = gpuOwnership.currentOwner(config);
    } catch (error) {
      ownershipError = error.message;
    }
  }
  const truth = deriveTrainingTruth({
    session,
    training_container: trainingContainer,
    rem_container: remContainer,
    nvidia,
    log,
    lock_owner: lockOwner,
    ownership_error: ownershipError,
    now_ms: Number(options.now_ms || Date.now()),
    startup_grace_ms: Number(
      config.training_observation_startup_grace_ms || 120000
    )
  });
  let reconciled = false;
  let reconciliationError = null;
  if (
    options.reconcile_stale_owner === true &&
    truth.stale_gpu_owner === true &&
    truth.container_running !== true &&
    truth.process_alive !== true &&
    truth.gpu_compute_process !== true
  ) {
    const releaseOwner = typeof options.release_owner === 'function'
      ? options.release_owner
      : (
          typeof config.gpu_ownership_lock_file === 'string' &&
          config.gpu_ownership_lock_file.trim()
        )
        ? (owner) => gpuOwnership.release(owner, config)
        : null;
    if (!releaseOwner) {
      reconciliationError =
        'stale GPU owner reconciliation is unavailable without an authoritative release operation';
    } else {
      try {
        releaseOwner(lockOwner);
        reconciled = true;
      } catch (error) {
        reconciliationError = error.message;
      }
    }
  }
  return Object.freeze({
    ...truth,
    training_container: trainingContainer,
    rem_container: remContainer,
    log,
    ownership_error: ownershipError,
    stale_owner_reconciled: reconciled,
    reconciliation_error: reconciliationError,
    error: truth.observation_error || (
      truth.stale_gpu_owner
        ? 'stale GPU ownership record: ' + String(lockOwner) +
          ' has no observed live workload'
        : reconciliationError
    )
  });
}

module.exports = {
  deriveTrainingTruth,
  inspectContainer,
  observeTrainingReality,
  parseNvidiaRows,
  parsePodmanInspect,
  parsePodmanTop,
  queryNvidia,
  readActiveRem,
  readLogReality
};
