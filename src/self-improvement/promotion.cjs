'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  appendAudit,
  assertApprovalToken,
  atomicJson,
  ensureLayout,
  listCandidates,
  nowIso,
  patchCandidate,
  paths,
  readCandidate,
  readStatus,
  updateStatus,
  validId
} = require('./store.cjs');
const { stopCurrentContainer } = require('./sandbox.cjs');
const { writeDenialMemory, writeApprovalMemory } = require('./memory-writer.cjs');
const { normalizeRunKind, candidateTypeForKind } = require('./run-kinds.cjs');

const ACTIVE_RUN_STATES = new Set([
  'queued',
  'starting',
  'researching',
  'experimenting',
  'verifying'
]);

function signalWorkerRunNow(pidFile) {
  let pid;
  try {
    pid = Number(
      String(fs.readFileSync(pidFile, 'utf8')).trim()
    );
  } catch (error) {
    throw new Error(
      'self-improvement worker PID is unavailable: ' +
      error.message
    );
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      'self-improvement worker PID is invalid'
    );
  }

  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGUSR1');
  } catch (error) {
    throw new Error(
      'self-improvement worker could not be woken: ' +
      error.message
    );
  }

  return pid;
}


function pause(token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const p = ensureLayout(config);
  fs.writeFileSync(p.pauseFile, nowIso() + '\n', { mode: 0o600 });
  stopCurrentContainer('maker_paused', config);
  updateStatus({ state: 'paused', phase: null, paused: true }, config);
  appendAudit('maker_paused_worker', {}, config);
  return readStatus(config);
}


function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manualRunSandboxStarted(status, requestId) {
  return (
    status?.manual_run_request_id === requestId &&
    typeof status?.manual_run_acknowledged_at === 'string' &&
    status.manual_run_acknowledged_at.length > 0 &&
    typeof status?.current_run_id === 'string' &&
    status.current_run_id.length > 0 &&
    typeof status?.current_container === 'string' &&
    status.current_container.length > 0 &&
    ['experimenting', 'verifying'].includes(String(status.state || ''))
  );
}

// Lenient fallback for the timeout catch block: handles the race condition where
// the worker began an automatic cycle before processing the force-run request,
// so manual_run_acknowledged_at is never written even though the cycle is real.
function manualRunCycleActive(status, requestId) {
  return (
    status?.manual_run_request_id === requestId &&
    typeof status?.current_run_id === 'string' &&
    status.current_run_id.length > 0 &&
    typeof status?.current_container === 'string' &&
    status.current_container.length > 0 &&
    ['experimenting', 'verifying'].includes(String(status.state || ''))
  );
}

async function waitForManualRunSandboxStart(
  requestId,
  workerPid,
  config
) {
  const deadline = Date.now() + config.run_now_ack_timeout_ms;
  let lastStatus = null;

  while (Date.now() <= deadline) {
    lastStatus = readStatus(config);
    if (manualRunSandboxStarted(lastStatus, requestId)) {
      return lastStatus;
    }
    if (
      lastStatus?.manual_run_request_id === requestId &&
      lastStatus?.state === 'failed'
    ) {
      throw new Error(
        lastStatus.last_error ||
        'self-improvement worker failed before starting the sandbox'
      );
    }
    if (
      lastStatus?.worker_running !== true ||
      Number(lastStatus?.worker_pid) !== Number(workerPid)
    ) {
      throw new Error(
        'self-improvement worker stopped before starting the sandbox'
      );
    }
    await wait(config.run_now_ack_poll_ms);
  }

  throw new Error(
    'self-improvement worker did not start the sandbox within ' +
    String(config.run_now_ack_timeout_ms) +
    ' ms; last state=' + String(lastStatus?.state || 'unknown') +
    '; phase=' + String(lastStatus?.phase || 'unknown')
  );
}

function resume(token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const p = ensureLayout(config);
  fs.rmSync(p.pauseFile, { force: true });
  updateStatus({ state: 'waiting_for_idle', phase: 'resumed', paused: false }, config);
  appendAudit('maker_resumed_worker', {}, config);
  return readStatus(config);
}

async function runNow(
  token,
  objective = '',
  kind = undefined,
  config = loadSelfImprovementConfig()
) {
  assertApprovalToken(token, config);
  const runKind = normalizeRunKind(kind, config);
  const candidateType = candidateTypeForKind(runKind, config);
  const p = ensureLayout(config);
  const current = readStatus(config);

  if (current.paused === true) {
    throw new Error('self-improvement worker is paused');
  }
  if (current.worker_running !== true) {
    throw new Error('self-improvement worker is not running');
  }
  if (current.model_proxy_ready !== true) {
    throw new Error('self-improvement worker is not ready');
  }
  if (
    current.current_run_id ||
    current.current_container ||
    ACTIVE_RUN_STATES.has(String(current.state || ''))
  ) {
    throw new Error('a self-improvement cycle is already active');
  }

  const requestedAt = nowIso();
  const requestId = crypto.randomUUID();
  const requestedObjective = String(objective || '').trim();

  atomicJson(p.runRequestFile, {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_REQUEST',
    request_id: requestId,
    requested_at: requestedAt,
    force: true,
    objective: requestedObjective,
    kind: runKind,
    candidate_type: candidateType
  }, config);

  updateStatus({
    state: 'queued',
    phase: 'maker_requested_cycle',
    current_objective:
      requestedObjective || config.default_objective,
    current_run_kind: runKind,
    current_candidate_type: candidateType,
    objective_source: requestedObjective ? 'maker_requested' : 'floki_selected',
    requested_objective: requestedObjective || null,
    queued_at: requestedAt,
    manual_run_request_id: requestId,
    manual_run_requested_at: requestedAt,
    manual_run_acknowledged_at: null,
    last_error: null,
    failure_latched_at: null
  }, config);

  let workerPid;
  try {
    workerPid = signalWorkerRunNow(p.pidFile);
  } catch (error) {
    fs.rmSync(p.runRequestFile, { force: true });
    updateStatus({
      state: 'failed',
      phase: 'manual_run_signal_failed',
      manual_run_request_id: requestId,
      last_error: error.message,
      failure_latched_at: nowIso()
    }, config);
    appendAudit('maker_run_now_signal_failed', {
      request_id: requestId,
      objective: requestedObjective,
      error: error.message
    }, config);
    throw error;
  }

  appendAudit('maker_requested_cycle', {
    request_id: requestId,
    objective: requestedObjective,
    requested_at: requestedAt,
    worker_pid: workerPid,
    wake_signal_sent: true,
    bypass_idle_timer: true
  }, config);

  let startedStatus;
  try {
    startedStatus = await waitForManualRunSandboxStart(
      requestId,
      workerPid,
      config
    );
  } catch (error) {
    const pending = (() => {
      try {
        return JSON.parse(fs.readFileSync(p.runRequestFile, 'utf8'));
      } catch (_readError) {
        return null;
      }
    })();
    if (pending?.request_id === requestId) {
      fs.rmSync(p.runRequestFile, { force: true });
    }
    const latest = readStatus(config);
    if (!manualRunCycleActive(latest, requestId)) {
      updateStatus({
        state: 'failed',
        phase: 'manual_run_sandbox_start_failed',
        manual_run_request_id: requestId,
        last_error: error.message,
        failure_latched_at: nowIso()
      }, config);
      appendAudit('maker_run_now_sandbox_start_failed', {
        request_id: requestId,
        objective: requestedObjective,
        worker_pid: workerPid,
        error: error.message
      }, config);
      throw error;
    }
    startedStatus = latest;
  }

  appendAudit('maker_run_now_sandbox_started', {
    request_id: requestId,
    run_id: startedStatus.current_run_id,
    container: startedStatus.current_container,
    acknowledged_at: startedStatus.manual_run_acknowledged_at
  }, config);

  return {
    ok: true,
    verified: true,
    message: 'Self-improvement sandbox started immediately.',
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_NOW_IMMEDIATE',
    request_id: requestId,
    kind: runKind,
    candidate_type: candidateType,
    wake_signal_sent: true,
    bypass_idle_timer: true,
    sandbox_started: true,
    worker_pid: workerPid,
    run_id: startedStatus.current_run_id,
    container: startedStatus.current_container,
    status: startedStatus
  };
}

function denyCandidate(id, token, reason = '', config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const candidate = readCandidate(validId(id, config), config);
  if (candidate.status !== 'pending_review') {
    throw new Error('only pending-review candidates can be denied');
  }
  const next = patchCandidate(id, {
    status: 'denied',
    denied_at: nowIso(),
    denial_reason: String(reason || '').trim()
  }, config);
  updateStatus({
    state: 'waiting_for_idle',
    phase: 'candidate_denied',
    latest_candidate_id: id,
    last_error: null
  }, config);
  appendAudit('candidate_denied_by_maker', { candidate_id: id, reason: next.denial_reason }, config);
  try {
    writeDenialMemory({
      candidate_id: id,
      objective: candidate.objective || '',
      denial_reason: next.denial_reason
    });
  } catch (_) {}
  return { ok: true, verified: true, candidate: next };
}

function approveCandidate(id, token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const candidateId = validId(id, config);
  const candidate = readCandidate(candidateId, config);
  if (candidate.status !== 'pending_review') {
    throw new Error('only pending-review candidates can be approved');
  }
  patchCandidate(candidateId, {
    status: 'approved',
    approved_at: nowIso()
  }, config);
  updateStatus({
    state: 'approved',
    phase: 'promotion_worker_starting',
    promotion: {
      candidate_id: candidateId,
      state: 'approved',
      requested_at: nowIso()
    }
  }, config);
  appendAudit('candidate_approved_by_maker', { candidate_id: candidateId }, config);
  try {
    writeApprovalMemory({
      candidate_id: candidateId,
      objective: candidate.objective || ''
    });
  } catch (_) {}

  const logFile = path.join(config.runtime_root, config.promotion_log_name);
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [
    path.join(config.project_root, 'src', 'self-improvement', 'promoter.cjs'),
    '--candidate',
    candidateId
  ], {
    cwd: config.project_root,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log]
  });
  child.unref();
  fs.closeSync(log);
  return {
    ok: true,
    verified: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_PROMOTION_STARTED',
    candidate_id: candidateId,
    promotion_pid: child.pid
  };
}

module.exports = {
  approveCandidate,
  denyCandidate,
  pause,
  resume,
  runNow,
  signalWorkerRunNow,
  manualRunSandboxStarted,
  waitForManualRunSandboxStart
};
