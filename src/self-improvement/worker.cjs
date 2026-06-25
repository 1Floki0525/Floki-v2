'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  appendAudit,
  ensureLayout,
  importOutbox,
  listCandidates,
  nowIso,
  paths,
  readStatus,
  readWorkerHeartbeat,
  readSandboxHeartbeat,
  safeJson,
  touchSandboxHeartbeat,
  touchWorkerHeartbeat,
  updateStatus
} = require('./store.cjs');
const { createSourceSnapshot } = require('./snapshot.cjs');
const { runSandbox, stopCurrentContainer } = require('./sandbox.cjs');
const { createModelProxy } = require('./model-proxy.cjs');

const ACTIVE_RUN_PREEMPT_REASONS = new Set([
  'foreground_turn_active',
  'memory_pressure'
]);

function shouldPreemptActiveRun(reason) {
  return ACTIVE_RUN_PREEMPT_REASONS.has(String(reason || ''));
}

function classifySandboxExit(exit, stopRequest, preemptReason) {
  const finalPreemptReason = stopRequest?.reason || preemptReason || null;
  if (finalPreemptReason) {
    return Object.freeze({
      ok: false,
      preempted: true,
      phase: 'preempted',
      reason: finalPreemptReason,
      requested_at: stopRequest?.requested_at || null
    });
  }

  if ((exit?.code === 137 || exit?.signal === 'SIGKILL') && !finalPreemptReason) {
    return Object.freeze({
      ok: false,
      killed: true,
      phase: 'sandbox_killed_137',
      reason: 'sandbox_killed_137'
    });
  }

  return Object.freeze({
    ok: exit?.code === 0,
    phase: exit?.code === 0 ? 'completed' : 'sandbox_failed',
    reason: exit?.code === 0 ? null : 'sandbox_failed'
  });
}

function isNoCandidateSandboxFailure(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('agent iteration limit reached without a verified candidate') ||
    text.includes('agent iteration wall-clock budget exceeded') ||
    text.includes('convergence policy ended the cycle without a verified candidate')
  );
}

function noCandidateStatusPatch(message, execution, completedAt = nowIso()) {
  return Object.freeze({
    state: 'waiting_for_idle',
    phase: 'no_verified_candidate',
    current_run_id: null,
    current_container: null,
    last_error: null,
    failure_latched_at: null,
    last_no_candidate_at: completedAt,
    last_no_candidate_error: String(message || ''),
    last_sandbox_log_file: execution?.log_file || null,
    last_cycle_completed_at: completedAt
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createServiceWakeController() {
  let pendingReason = null;
  let waiter = null;

  function wake(reason = 'manual_run_signal') {
    pendingReason = String(reason || 'manual_run_signal');
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    const resolvedReason = pendingReason;
    pendingReason = null;
    current.resolve(resolvedReason);
  }

  function wait(ms) {
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error(
        'worker wait duration must be a non-negative YAML-derived number'
      );
    }

    if (pendingReason) {
      const resolvedReason = pendingReason;
      pendingReason = null;
      return Promise.resolve(resolvedReason);
    }

    if (waiter) {
      throw new Error(
        'self-improvement worker already has an active wait'
      );
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (waiter && waiter.timer === timer) {
          waiter = null;
        }
        resolve('timeout');
      }, delay);

      waiter = {
        timer,
        resolve: (reason) => {
          clearTimeout(timer);
          resolve(reason);
        }
      };
    });
  }

  return Object.freeze({
    wake,
    wait
  });
}

function readRuntimeStatus(config) {
  return safeJson(
    path.join(config.chat_runtime_root, 'chat-local-runtime.status.json'),
    null
  );
}

function memoryAvailableMb() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB/im);
    return match ? Math.floor(Number(match[1]) / 1024) : Infinity;
  } catch (_error) {
    return Infinity;
  }
}

function latestActivityMs(runtime) {
  return Math.max(
    Date.parse(runtime?.last_turn_completed_at || '') || 0,
    Date.parse(runtime?.last_turn_started_at || '') || 0,
    Date.parse(runtime?.client_ready_at || '') || 0,
    Date.parse(runtime?.started_at || '') || 0
  );
}

function idleEligibility(runtime, status, config, force = false) {
  if (!runtime || runtime.api_ready !== true) {
    return { eligible: false, reason: 'chat_runtime_not_ready' };
  }
  if (runtime.active_turn === true) {
    return { eligible: false, reason: 'foreground_turn_active' };
  }
  if (runtime.hearing?.speaking === true) {
    return { eligible: false, reason: 'speech_output_active' };
  }
  if (status.paused === true) {
    return { eligible: false, reason: 'paused' };
  }
  if (memoryAvailableMb() < config.minimum_available_memory_mb) {
    return { eligible: false, reason: 'memory_pressure' };
  }

  const lastActivity = latestActivityMs(runtime);
  const failureAt = Date.parse(status.failure_latched_at || '') || 0;
  if (
    !force &&
    config.failure_requires_new_activity === true &&
    failureAt > 0 &&
    lastActivity <= failureAt
  ) {
    return { eligible: false, reason: 'failure_waiting_for_new_activity' };
  }
  if (!force && Date.now() - lastActivity < config.idle_seconds * 1000) {
    return { eligible: false, reason: 'idle_threshold_not_reached' };
  }
  return {
    eligible: true,
    reason: force ? 'manual_force' : 'idle_threshold_reached'
  };
}

function pendingCandidateExists(config) {
  return listCandidates(config).some((candidate) =>
    ['pending_review', 'approved', 'validating', 'deploying'].includes(
      candidate.status
    )
  );
}

function readRunRequest(config) {
  return safeJson(paths(config).runRequestFile, null);
}

function clearRunRequest(config) {
  fs.rmSync(paths(config).runRequestFile, { force: true });
}


function resolveManualRunRequest(fileRequest, status, config) {
  if (fileRequest?.force === true) {
    return fileRequest;
  }
  if (
    status?.state === 'queued' &&
    status?.phase === 'maker_requested_cycle' &&
    typeof status?.manual_run_request_id === 'string' &&
    status.manual_run_request_id.length > 0
  ) {
    return Object.freeze({
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_REQUEST_STATUS_FALLBACK',
      request_id: status.manual_run_request_id,
      requested_at:
        status.manual_run_requested_at || status.queued_at || null,
      force: true,
      objective: status.current_objective || config.default_objective
    });
  }
  return fileRequest;
}

async function runCycle(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (pendingCandidateExists(config)) {
    updateStatus({
      state: 'pending_review',
      phase: 'awaiting_maker_decision'
    }, config);
    return {
      ok: false,
      skipped: true,
      reason: 'candidate_pending_review'
    };
  }

  const snapshot = createSourceSnapshot({ config });
  updateStatus({
    state: 'researching',
    phase: 'snapshot_ready',
    current_run_id: snapshot.run_id,
    current_objective: options.objective || null,
    last_cycle_started_at: nowIso(),
    last_error: null,
    failure_latched_at: null
  }, config);
  touchWorkerHeartbeat(config);

  const execution = runSandbox(snapshot, {
    config,
    objective: options.objective
  });
  let preemptReason = null;
  const cycleStartMs = Date.now();
  try {
    await execution.wait_for_container_start();
    if (options.manual_request_id) {
      const acknowledgedAt = nowIso();
      updateStatus({
        manual_run_request_id: options.manual_request_id,
        manual_run_acknowledged_at: acknowledgedAt
      }, config);
      appendAudit('manual_run_acknowledged', {
        request_id: options.manual_request_id,
        requested_at: options.manual_requested_at || null,
        run_id: snapshot.run_id,
        container: execution.container_name,
        acknowledged_at: acknowledgedAt
      }, config);
    }
  } catch (error) {
    try {
      execution.child.kill('SIGTERM');
    } catch (_killError) {
    }
    execution.cleanup();
    throw error;
  }
  const preemptTimer = setInterval(() => {
    const status = readStatus(config);
    updateStatus({}, config);
    touchWorkerHeartbeat(config);
    touchSandboxHeartbeat(config, snapshot.run_id);
    const lastSandboxHeartbeat = readSandboxHeartbeat(config);
    const lastSandboxMs = lastSandboxHeartbeat ? Date.parse(lastSandboxHeartbeat.observed_at || '') : null;
    const stallMs = lastSandboxMs ? (Date.now() - lastSandboxMs) : 0;
    const stalled =
      stallMs > config.shell_command_stalled_threshold_ms;
    const runtime = readRuntimeStatus(config);
    const eligibility = idleEligibility(
      runtime,
      status,
      config,
      options.force === true
    );
    if (
      !eligibility.eligible &&
      shouldPreemptActiveRun(eligibility.reason)
    ) {
      preemptReason = eligibility.reason;
      stopCurrentContainer(eligibility.reason, config);
    }
    if (status.paused === true) {
      preemptReason = 'paused';
      stopCurrentContainer('paused', config);
    }
    if (stalled) {
      appendAudit('command_stalled', { run_id: snapshot.run_id, stall_ms: stallMs }, config);
    }
    const next = {
      last_real_progress_at: new Date(Math.max(cycleStartMs, lastSandboxMs || cycleStartMs)).toISOString(),
      current_command_elapsed_ms: Date.now() - cycleStartMs,
      stalled
    };
    updateStatus(next, config);
  }, config.worker_preemption_poll_ms);

  const exit = await new Promise((resolve) => {
    execution.child.once(
      'close',
      (code, signal) => resolve({ code, signal })
    );
    execution.child.once(
      'error',
      (error) => resolve({ code: -1, signal: null, error })
    );
  });
  clearInterval(preemptTimer);
  const stopRequest = execution.read_stop_request();
  const classification = classifySandboxExit(exit, stopRequest, preemptReason);
  execution.cleanup();

  if (classification.preempted) {
    updateStatus({
      state: 'waiting_for_idle',
      phase: 'preempted',
      current_run_id: null,
      current_container: null,
      last_error: null,
      last_sandbox_log_file: execution.log_file,
      last_cycle_completed_at: nowIso()
    }, config);
    appendAudit(
      'cycle_preempted',
      {
        run_id: snapshot.run_id,
        reason: classification.reason,
        requested_at: classification.requested_at || null
      },
      config
    );
    return {
      ok: false,
      preempted: true,
      reason: classification.reason
    };
  }

  if (exit.code !== 0 && exit.code !== 137) {
    const summary = execution.read_error_tail();
    const base = exit.error
      ? exit.error.message
      : 'sandbox exited with status ' + exit.code +
        (exit.signal ? ' signal ' + exit.signal : '');
    const message = summary ? base + '\n\n' + summary : base;
    const failedAt = nowIso();
    if (isNoCandidateSandboxFailure(message)) {
      updateStatus(noCandidateStatusPatch(message, execution, failedAt), config);
      appendAudit(
        'cycle_no_candidate',
        {
          run_id: snapshot.run_id,
          exit_code: exit.code,
          signal: exit.signal,
          reason: 'no_verified_candidate',
          error: message,
          sandbox_log_file: execution.log_file
        },
        config
      );
      return { ok: false, no_candidate: true, error: message };
    }
    updateStatus({
      state: 'failed',
      phase: classification.phase,
      current_run_id: null,
      current_container: null,
      last_error: message,
      failure_latched_at: failedAt,
      last_sandbox_log_file: execution.log_file,
      last_cycle_completed_at: failedAt
    }, config);
    appendAudit(
      classification.killed ? 'cycle_killed_137' : 'cycle_failed',
      {
        run_id: snapshot.run_id,
        exit_code: exit.code,
        signal: exit.signal,
        reason: classification.reason,
        error: message,
        sandbox_log_file: execution.log_file
      },
      config
    );
    return { ok: false, error: message };
  }

  const candidate = importOutbox(snapshot.run_id, config);
  return { ok: true, candidate_id: candidate.id };
}

async function serviceLoop(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const p = ensureLayout(config);
  const wakeController = createServiceWakeController();
  const onManualRunSignal = () => {
    wakeController.wake('manual_run_signal');
    appendAudit('worker_manual_run_signal_received', {
      pid: process.pid
    }, config);
  };
  process.on('SIGUSR1', onManualRunSignal);
  const modelProxy = createModelProxy(config);
  await modelProxy.start();
  fs.writeFileSync(p.pidFile, String(process.pid) + '\n', { mode: 0o600 });
  process.once('exit', () => fs.rmSync(p.pidFile, { force: true }));
  fs.rmSync(
    path.join(config.runtime_root, config.sandbox_heartbeat_file_name),
    { force: true }
  );

  let stopping = false;
  const requestStop = (reason = 'worker_shutdown') => {
    if (stopping) return;
    stopping = true;
    stopCurrentContainer(reason, config);
    wakeController.wake(reason);
  };
  const signalNames = options.process_signal_names || ['SIGTERM', 'SIGINT'];
  const signalHandlers = new Map();
  for (const signal of signalNames) {
    const handler = () => {
      requestStop('worker_shutdown');
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  if (options.stop_signal) {
    if (options.stop_signal.aborted) {
      requestStop('worker_shutdown');
    } else {
      options.stop_signal.addEventListener(
        'abort',
        () => {
          requestStop('worker_shutdown');
        },
        { once: true }
      );
    }
  }

  const previousStatus = readStatus(config);
  const previousFailureLatch =
    previousStatus.failure_latched_at || null;

  updateStatus({
    state: config.enabled ? 'waiting_for_idle' : 'disabled',
    phase: null,
    worker_running: true,
    model_proxy_ready: true,
    started_at: nowIso(),
    last_error: null,
    failure_latched_at: previousFailureLatch,
    last_no_candidate_at: previousStatus.last_no_candidate_at || null,
    last_no_candidate_error:
      previousStatus.last_no_candidate_error || null,
    current_run_id: null,
    current_container: null,
    current_command: null,
    current_command_started_at: null,
    current_command_elapsed_ms: 0,
    last_real_progress_at: null,
    stalled: false,
    worker_alive_at: nowIso(),
    sandbox_alive_at: null
  }, config);
  touchWorkerHeartbeat(config);
  appendAudit('worker_started', { pid: process.pid }, config);

  while (!stopping) {
    touchWorkerHeartbeat(config);
    const status = readStatus(config);
    if (!config.enabled) {
      updateStatus({ state: 'disabled', phase: null }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }
    if (status.paused) {
      updateStatus({ state: 'paused', phase: null }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }
    if (pendingCandidateExists(config)) {
      updateStatus({
        state: 'pending_review',
        phase: 'awaiting_maker_decision'
      }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }

    const fileRequest = readRunRequest(config);
    const request = resolveManualRunRequest(
      fileRequest,
      status,
      config
    );
    const runtime = readRuntimeStatus(config);
    const eligibility = idleEligibility(
      runtime,
      status,
      config,
      request?.force === true
    );
    if (!eligibility.eligible) {
      updateStatus({
        state: 'waiting_for_idle',
        phase: eligibility.reason,
        current_objective: request?.objective || null
      }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }

    if (request?.force === true) {
      updateStatus({
        state: 'starting',
        phase: 'manual_run_starting',
        manual_run_request_id: request.request_id || null,
        manual_run_acknowledged_at: null,
        current_objective:
          request.objective || config.default_objective,
        last_error: null,
        failure_latched_at: null
      }, config);
    }

    clearRunRequest(config);
    try {
      await runCycle({
        config,
        force: request?.force === true,
        objective: request?.objective || '',
        manual_request_id:
          request?.force === true ? request.request_id || null : null,
        manual_requested_at:
          request?.force === true ? request.requested_at || null : null
      });
    } catch (error) {
      const failedAt = nowIso();
      updateStatus({
        state: 'failed',
        phase: 'worker_exception',
        current_run_id: null,
        current_container: null,
        last_error: error.stack || error.message,
        failure_latched_at: failedAt,
        last_cycle_completed_at: failedAt
      }, config);
      appendAudit(
        'worker_exception',
        { error: error.stack || error.message, failed_at: failedAt },
        config
      );
    }
    if (stopping) break;
    await wakeController.wait(config.cooldown_seconds * 1000);
  }

  process.removeListener(
    'SIGUSR1',
    onManualRunSignal
  );
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  await modelProxy.stop();
  updateStatus({
    state: 'stopped',
    phase: null,
    worker_running: false,
    model_proxy_ready: false
  }, config);
  appendAudit('worker_stopped', { pid: process.pid }, config);
  fs.rmSync(p.pidFile, { force: true });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--once')) {
    const result = await runCycle({ force: args.has('--force') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  await serviceLoop();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_WORKER_FAIL',
      error: error.stack || error.message
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  createServiceWakeController,
  idleEligibility,
  latestActivityMs,
  memoryAvailableMb,
  pendingCandidateExists,
  readRuntimeStatus,
  resolveManualRunRequest,
  classifySandboxExit,
  isNoCandidateSandboxFailure,
  noCandidateStatusPatch,
  runCycle,
  serviceLoop,
  shouldPreemptActiveRun
};
