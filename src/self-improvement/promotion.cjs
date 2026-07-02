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
const {
  assertRunNowAllowed
} = require('./nightly-policy.cjs');

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
    (
      status.current_run_kind === 'training'
        ? status.state === 'training'
        : ['experimenting', 'verifying'].includes(String(status.state || ''))
    )
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
    (
      status.current_run_kind === 'training'
        ? status.state === 'training'
        : ['experimenting', 'verifying'].includes(String(status.state || ''))
    )
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

function nightCycleWindow(
  config,
  now = new Date(),
  options = {}
) {
  if (
    config.training_enabled !== true ||
    config.nightly_training_enabled !== true
  ) {
    return false;
  }

  const isWithin =
    options.is_within_sleep_window ||
    require('../chat/sleep-cycle.cjs').isWithinSleepWindow;

  return isWithin(now);
}

async function joinCurrentNightlyTrainingSession(
  input,
  options = {}
) {
  const {
    request_id: requestId,
    requested_at: requestedAt,
    requested_objective: requestedObjective,
    candidate_type: candidateType,
    paths: runtimePaths,
    config
  } = input;

  const readSession =
    options.read_nightly_session ||
    require(
      './training/nightly-training-session.cjs'
    ).readNightlySession;
  const readCurrentStatus =
    options.read_status || readStatus;
  const updateCurrentStatus =
    options.update_status || updateStatus;
  const signalWorker =
    options.signal_worker || signalWorkerRunNow;
  const delay =
    options.wait || wait;

  const workerPid = signalWorker(runtimePaths.pidFile);
  const deadline =
    Date.now() + Number(config.run_now_ack_timeout_ms);
  let latest = readCurrentStatus(config);

  while (Date.now() <= deadline) {
    const currentSession = readSession(config);
    latest = readCurrentStatus(config);

    if (
      currentSession &&
      currentSession.active === true &&
      currentSession.finalized !== true &&
      typeof currentSession.run_id === 'string' &&
      currentSession.run_id.length > 0
    ) {
      const acknowledgedAt = nowIso();
      const phase =
        typeof latest?.phase === 'string' &&
        latest.phase.startsWith('nightly_')
          ? latest.phase
          : 'nightly_training_session_active';

      const status = updateCurrentStatus({
        state: 'training',
        phase,
        current_run_id: currentSession.run_id,
        current_run_kind: 'training',
        current_candidate_type: candidateType,
        current_objective:
          requestedObjective ||
          config.nightly_training_default_objective,
        objective_source:
          requestedObjective
            ? 'maker_requested'
            : 'floki_selected',
        requested_objective:
          requestedObjective || null,
        manual_run_request_id: requestId,
        manual_run_requested_at: requestedAt,
        manual_run_acknowledged_at: acknowledgedAt,
        last_error: null,
        failure_latched_at: null
      }, config);

      appendAudit('maker_joined_nightly_training_session', {
        request_id: requestId,
        run_id: currentSession.run_id,
        sleep_date: currentSession.sleep_date || null,
        session_status: currentSession.status || null
      }, config);

      return Object.freeze({
        worker_pid: workerPid,
        session: currentSession,
        status
      });
    }

    if (
      latest?.worker_running !== true ||
      Number(latest?.worker_pid) !== Number(workerPid)
    ) {
      throw new Error(
        'self-improvement worker stopped before the nightly ' +
        'training session became available'
      );
    }

    await delay(config.run_now_ack_poll_ms);
  }

  throw new Error(
    'nightly training session did not become available within ' +
    String(config.run_now_ack_timeout_ms) +
    ' ms'
  );
}

function hasActiveCycle(status) {
  const state = String(status?.state || '');
  return Boolean(
    status?.current_run_id ||
    status?.current_container ||
    ACTIVE_RUN_STATES.has(state) ||
    state === 'training'
  );
}

function activeCycleKind(
  status,
  config = loadSelfImprovementConfig()
) {
  return normalizeRunKind(
    status?.current_run_kind ||
      status?.active_run_kind ||
      config.default_rsi_run_kind,
    config
  );
}

function activeCodeCycle(
  status,
  config = loadSelfImprovementConfig()
) {
  return (
    hasActiveCycle(status) &&
    activeCycleKind(status, config) === 'code'
  );
}

function activeTrainingCycle(
  status,
  config = loadSelfImprovementConfig()
) {
  return (
    hasActiveCycle(status) &&
    activeCycleKind(status, config) === 'training'
  );
}

async function waitForCycleClear(
  active,
  config = loadSelfImprovementConfig(),
  options = {}
) {
  const read = options.read_status || readStatus;
  const stop =
    options.stop_current_container || stopCurrentContainer;
  const waitFn = options.wait || wait;
  const reason = String(
    options.reason || 'maker_cancelled_active_cycle'
  );
  const timeoutMs = Math.max(
    1000,
    Number(
      options.timeout_ms ||
      config.run_now_ack_timeout_ms
    )
  );
  const pollMs = Math.max(
    10,
    Number(
      options.poll_ms ||
      config.run_now_ack_poll_ms
    )
  );
  const deadline = Date.now() + timeoutMs;
  const targetRunId = active?.current_run_id || null;
  const targetContainer = active?.current_container || null;
  let last = active || null;

  while (Date.now() <= deadline) {
    last = read(config);
    const sameRun =
      targetRunId &&
      last?.current_run_id === targetRunId;
    const sameContainer =
      targetContainer &&
      last?.current_container === targetContainer;
    const codeStillActive = activeCodeCycle(last, config);

    if (
      !sameRun &&
      !sameContainer &&
      !codeStillActive
    ) {
      return last;
    }

    if (last?.current_container) {
      stop(reason, config);
    }

    await waitFn(pollMs);
  }

  throw new Error(
    'active code sandbox did not stop within ' +
    String(timeoutMs) +
    ' ms; run_id=' +
    String(last?.current_run_id || 'none') +
    '; container=' +
    String(last?.current_container || 'none') +
    '; state=' +
    String(last?.state || 'unknown') +
    '; phase=' +
    String(last?.phase || 'unknown')
  );
}

async function preemptCodeCycleForTraining(
  current,
  config = loadSelfImprovementConfig(),
  options = {}
) {
  if (!activeCodeCycle(current, config)) {
    throw new Error(
      'training preemption requires an active code cycle'
    );
  }

  const p = options.layout || ensureLayout(config);
  const removeFile =
    options.remove_file ||
    ((file) => fs.rmSync(file, { force: true }));
  const stop =
    options.stop_current_container || stopCurrentContainer;
  const update = options.update_status || updateStatus;
  const audit = options.append_audit || appendAudit;
  const wake = options.signal_worker || signalWorkerRunNow;
  const reason =
    'maker_training_preempted_code_sandbox';

  let pendingRequestCancelled = false;
  try {
    if (fs.existsSync(p.runRequestFile)) {
      removeFile(p.runRequestFile);
      pendingRequestCancelled = true;
    }
  } catch (error) {
    throw new Error(
      'failed to cancel the pending code request: ' +
      error.message
    );
  }

  update({
    phase: 'training_preempting_code_sandbox',
    preemption_requested_at: nowIso(),
    preemption_reason: reason
  }, config);

  const stopRequested = stop(reason, config);

  try {
    wake(p.pidFile);
  } catch (_error) {
    // A running container exits independently after the Podman stop.
  }

  let cleared;
  if (
    !current.current_run_id &&
    !current.current_container
  ) {
    update({
      state: 'waiting_for_idle',
      phase: 'code_sandbox_cancelled_for_training',
      current_run_id: null,
      current_container: null,
      current_run_kind: null,
      current_candidate_type: null,
      manual_run_pending: false,
      manual_run_request_id: null,
      manual_run_acknowledged_at: null,
      last_error: null
    }, config);
    cleared = (options.read_status || readStatus)(config);
  } else {
    cleared = await waitForCycleClear(
      current,
      config,
      {
        ...options,
        reason
      }
    );
  }

  audit(
    'code_sandbox_preempted_for_training',
    {
      run_id: current.current_run_id || null,
      container: current.current_container || null,
      stop_requested: stopRequested === true,
      pending_request_cancelled:
        pendingRequestCancelled,
      cleared_state: cleared?.state || null,
      cleared_phase: cleared?.phase || null
    },
    config
  );

  return Object.freeze({
    ok: true,
    verified: true,
    marker:
      'FLOKI_V2_CODE_SANDBOX_PREEMPTED_FOR_TRAINING',
    run_id: current.current_run_id || null,
    container: current.current_container || null,
    stop_requested: stopRequested === true,
    pending_request_cancelled:
      pendingRequestCancelled,
    status: cleared
  });
}

async function abortActiveRun(
  token,
  reason = '',
  kind = undefined,
  config = loadSelfImprovementConfig(),
  options = {}
) {
  assertApprovalToken(token, config);

  const p = options.layout || ensureLayout(config);
  const read = options.read_status || readStatus;
  const update = options.update_status || updateStatus;
  const audit = options.append_audit || appendAudit;
  const stop =
    options.stop_current_container || stopCurrentContainer;
  const removeFile =
    options.remove_file ||
    ((file) => fs.rmSync(file, { force: true }));

  const current = read(config);
  const runKind = normalizeRunKind(
    kind ||
      current.current_run_kind ||
      config.default_rsi_run_kind,
    config
  );
  const abortReason = String(
    reason || ('maker_stop_' + runKind)
  );

  let pendingRequestCancelled = false;
  if (fs.existsSync(p.runRequestFile)) {
    removeFile(p.runRequestFile);
    pendingRequestCancelled = true;
  }

  const wasActive = hasActiveCycle(current);
  const stopRequested = stop(abortReason, config);

  let cleared = current;
  if (
    wasActive &&
    (current.current_run_id || current.current_container)
  ) {
    cleared = await waitForCycleClear(
      current,
      config,
      {
        ...options,
        reason: abortReason
      }
    );
  } else {
    update({
      state: 'waiting_for_idle',
      phase:
        runKind === 'training'
          ? 'training_aborted'
          : 'code_sandbox_stopped',
      current_run_id: null,
      current_container: null,
      current_run_kind: null,
      current_candidate_type: null,
      manual_run_pending: false,
      manual_run_request_id: null,
      manual_run_acknowledged_at: null,
      last_error: null
    }, config);
    cleared = read(config);
  }

  audit(
    'maker_active_run_stopped',
    {
      run_kind: runKind,
      reason: abortReason,
      run_id: current.current_run_id || null,
      container: current.current_container || null,
      stop_requested: stopRequested === true,
      pending_request_cancelled:
        pendingRequestCancelled
    },
    config
  );

  return Object.freeze({
    ok: true,
    verified: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_STOPPED',
    stopped: true,
    abort_requested:
      stopRequested === true ||
      pendingRequestCancelled ||
      wasActive,
    stop_requested: stopRequested === true,
    pending_request_cancelled:
      pendingRequestCancelled,
    run_kind: runKind,
    reason: abortReason,
    status: cleared
  });
}

async function runNow(
  token,
  objective = '',
  kind = undefined,
  config = loadSelfImprovementConfig()
) {
  assertApprovalToken(token, config);
  try {
    assertRunNowAllowed(config);
  } catch (error) {
    appendAudit(
      'maker_run_now_blocked_nightly_hf_cycle',
      {
        objective: String(objective || '').trim(),
        kind: kind || null,
        error: error.message
      },
      config
    );
    throw error;
  }
  const runKind = normalizeRunKind(kind, config);
  const candidateType = candidateTypeForKind(runKind, config);
  const p = ensureLayout(config);
  let current = readStatus(config);

  if (current.paused === true) {
    throw new Error('self-improvement worker is paused');
  }
  if (current.worker_running !== true) {
    throw new Error('self-improvement worker is not running');
  }

  const inNightCycle = nightCycleWindow(
    config,
    new Date()
  );

  if (inNightCycle && runKind === 'training') {
    const requestedAt = nowIso();
    const requestId = crypto.randomUUID();
    const requestedObjective =
      String(objective || '').trim();

    const joined =
      await joinCurrentNightlyTrainingSession({
        request_id: requestId,
        requested_at: requestedAt,
        requested_objective: requestedObjective,
        candidate_type: candidateType,
        paths: p,
        config
      });

    const currentSession = joined.session;
    const containerStarted = Boolean(
      currentSession.current_container
    );

    return {
      ok: true,
      verified: true,
      message:
        'Joined the active nightly epoch/REM training session.',
      marker:
        'FLOKI_V2_NIGHTLY_TRAINING_SESSION_JOINED',
      request_id: requestId,
      kind: runKind,
      candidate_type: candidateType,
      wake_signal_sent: true,
      bypass_idle_timer: true,
      nightly_session_joined: true,
      production_training_path: 'nightly_segmented',
      sandbox_started: containerStarted,
      training_container_started: containerStarted,
      training_resource_mode_entered:
        currentSession.resource_entered === true,
      worker_pid: joined.worker_pid,
      run_id: currentSession.run_id,
      container:
        currentSession.current_container || null,
      sleep_date:
        currentSession.sleep_date || null,
      session_status:
        currentSession.status || null,
      status: joined.status
    };
  }

  const manualNightCodeOverride =
    inNightCycle && runKind === 'code';
  if (current.model_proxy_ready !== true) {
    throw new Error('self-improvement worker is not ready');
  }
  const nightlyStatusOnly = Boolean(
    manualNightCodeOverride &&
    current.current_run_kind === 'training' &&
    typeof current.phase === 'string' &&
    current.phase.startsWith('nightly_')
  );

  if (hasActiveCycle(current)) {
    if (
      runKind === 'training' &&
      activeCodeCycle(current, config)
    ) {
      const preemption =
        await preemptCodeCycleForTraining(
          current,
          config
        );
      current = preemption.status || readStatus(config);
    } else if (
      runKind === 'training' &&
      activeTrainingCycle(current, config)
    ) {
      return {
        ok: true,
        verified: true,
        message:
          'Training is already active; attached to the existing run.',
        marker:
          'FLOKI_V2_SELF_IMPROVEMENT_TRAINING_JOINED',
        request_id:
          current.manual_run_request_id || null,
        kind: 'training',
        candidate_type:
          current.current_candidate_type ||
          candidateType,
        wake_signal_sent: false,
        bypass_idle_timer: true,
        sandbox_started: true,
        training_container_started: false,
        training_resource_mode_entered:
          current.training_resource_mode === 'active',
        joined_existing_training: true,
        worker_pid: current.worker_pid || null,
        run_id: current.current_run_id,
        container: current.current_container,
        status: current
      };
    } else {
      throw new Error(
        'a self-improvement cycle is already active'
      );
    }
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

  const trainingRun = runKind === 'training';
  return {
    ok: true,
    verified: true,
    message: trainingRun
      ? 'QLoRA training container started and acquired training resource mode.'
      : 'Self-improvement sandbox started immediately.',
    marker: trainingRun
      ? 'FLOKI_V2_SELF_IMPROVEMENT_TRAINING_STARTED'
      : 'FLOKI_V2_SELF_IMPROVEMENT_RUN_NOW_IMMEDIATE',
    request_id: requestId,
    kind: runKind,
    candidate_type: candidateType,
    wake_signal_sent: true,
    bypass_idle_timer: true,
    sandbox_started: true,
    training_container_started: trainingRun,
    training_resource_mode_entered: trainingRun,
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
  if (candidate.candidate_type === 'model_adapter') {
    throw new Error('model_adapter candidates require independent adapter evaluation and the dedicated adapter promotion path');
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
  waitForCycleClear,
  preemptCodeCycleForTraining,
  hasActiveCycle,
  activeTrainingCycle,
  activeCodeCycle,
  abortActiveRun,
  nightCycleWindow,
  joinCurrentNightlyTrainingSession,
  approveCandidate,
  denyCandidate,
  pause,
  resume,
  runNow,
  signalWorkerRunNow,
  manualRunSandboxStarted,
  waitForManualRunSandboxStart
};
