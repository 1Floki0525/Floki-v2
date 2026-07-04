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
const { normalizeRunKind, candidateTypeForKind } = require('./run-kinds.cjs');
const {
  evaluateNightlyPolicy
} = require('./nightly-policy.cjs');
const { runTrainingCycle } = require('./training/training-runner.cjs');
const {
  writeCycleMemory,
  flushAgentMemoryOutbox
} = require('./memory-writer.cjs');

const ACTIVE_RUN_PREEMPT_REASONS = new Set([
  'foreground_turn_active',
  'memory_pressure',
  'nightly_hf_cycle'
]);

const NO_CANDIDATE_STOP_REASONS = new Set([
  'agent_run_wall_clock_budget_exceeded',
  'implementation_write_deadline_exceeded',
  'implementation_progress_stalled',
  'focused_repair_progress_stalled',
  'model_turn_deadline_exceeded',
  'transient_model_failure_budget_exhausted'
]);

function shouldPreemptActiveRun(reason) {
  return ACTIVE_RUN_PREEMPT_REASONS.has(String(reason || ''));
}

function isNoCandidateStopReason(reason) {
  return NO_CANDIDATE_STOP_REASONS.has(String(reason || ''));
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
    text.includes('convergence policy ended the cycle without a verified candidate') ||
    text.includes('floki_v2_self_improvement_sandbox_no_candidate') ||
    Array.from(NO_CANDIDATE_STOP_REASONS).some((reason) => text.includes(reason))
  );
}

function classifyNoCandidateReason(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('iteration limit reached') || text.includes('iteration_limit')) return 'iteration_limit';
  if (text.includes('agent_run_wall_clock_budget_exceeded')) return 'agent_run_wall_clock_budget_exceeded';
  if (text.includes('implementation_write_deadline_exceeded')) return 'implementation_write_deadline_exceeded';
  if (text.includes('focused_repair_progress_stalled')) return 'focused_repair_progress_stalled';
  if (text.includes('transient_model_failure_budget_exhausted')) return 'transient_model_failure_budget_exhausted';
  if (text.includes('model_turn_deadline_exceeded')) return 'model_turn_deadline_exceeded';
  if (text.includes('implementation_progress_stalled')) return 'implementation_progress_stalled';
  if (text.includes('wall-clock budget exceeded') || text.includes('wall_clock_limit')) return 'agent_run_wall_clock_budget_exceeded';
  if (
    text.includes('implementation_has_no_workspace_change') ||
    text.includes('no_workspace_change') ||
    text.includes('no_source_change')
  ) return 'implementation_has_no_workspace_change';
  if (
    text.includes('model_request_failed') ||
    text.includes('model_request_failure') ||
    text.includes('model_error')
  ) return 'transient_model_failure_budget_exhausted';
  if (text.includes('tool_failure') || text.includes('tool_error')) return 'tool_failure';
  if (text.includes('duplicate_experiment') || text.includes('duplicate experiment')) return 'duplicate_experiment_rejection';
  if (text.includes('focused_test_failed') || text.includes('focused_verification_failed')) return 'focused_test_failure';
  if (text.includes('sandbox_failure') || text.includes('container_failure')) return 'sandbox_container_failure';
  if (text.includes('convergence policy ended') || text.includes('convergence_refusal')) return 'convergence_refusal';
  return 'controlled_no_verified_candidate';
}

function parseAgentAuditRecords(text) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && record.marker === 'FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT') {
        records.push(record);
      }
    } catch (_error) {
    }
  }
  return records;
}

function conciseNoCandidateStatus(message, execution, completedAt = nowIso()) {
  const records = parseAgentAuditRecords(message);
  const noCandidate = [...records]
    .reverse()
    .find((record) => record.type === 'no_candidate');
  const heartbeat = [...records]
    .reverse()
    .find((record) => record.type === 'progress_heartbeat');
  const detail = noCandidate?.detail || {};
  const convergence = detail.convergence || heartbeat?.detail || {};
  const heartbeatDetail = heartbeat?.detail || {};
  const runId =
    detail.run_id ||
    heartbeatDetail.run_id ||
    execution?.run_id ||
    null;
  const reason = classifyNoCandidateReason(
    detail.reason ||
      noCandidate?.reason ||
      heartbeatDetail.reason ||
      message
  );
  return Object.freeze({
    run_id: runId,
    reason,
    phase:
      convergence.phase ||
      heartbeatDetail.phase ||
      null,
    iteration:
      convergence.iteration ??
      heartbeatDetail.iteration ??
      null,
    write_count:
      convergence.write_count ??
      heartbeatDetail.write_count ??
      null,
    last_write_iteration:
      convergence.last_write_iteration ??
      heartbeatDetail.last_write_iteration ??
      null,
    last_write_time:
      heartbeatDetail.last_write_time ||
      null,
    elapsed_ms:
      detail.elapsed_ms ??
      heartbeatDetail.elapsed_ms ??
      null,
    selected_objective:
      convergence.selected_experiment?.objective ||
      heartbeatDetail.selected_experiment ||
      null,
    terminal_log_file: execution?.log_file || null,
    timestamp: completedAt
  });
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
    last_no_candidate_error: conciseNoCandidateStatus(
      message,
      execution,
      completedAt
    ),
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

function automaticNightCycleOwnsWorker(
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

  if (isWithin(now)) return true;

  const readSession =
    options.read_nightly_session ||
    require(
      './training/nightly-training-session.cjs'
    ).readNightlySession;

  const current = readSession(config);
  return Boolean(
    current &&
    current.active === true &&
    current.finalized !== true
  );
}

async function pauseNightlyTrainingForManualCode(
  config,
  options = {}
) {
  const sessionModule =
    options.session_module ||
    require('./training/nightly-training-session.cjs');
  const runtimeClient =
    options.runtime_client ||
    require('./training/runtime-client.cjs');

  let current = sessionModule.readNightlySession(config);
  if (!current || current.finalized === true) {
    return Object.freeze({
      ok: true,
      paused: false,
      reason: 'no_active_nightly_session',
      session: current
    });
  }

  if (current.current_container) {
    const checkpoint =
      await sessionModule.checkpointNightlyTraining(
        current,
        {
          config,
          reason: 'manual_code_run_now_override',
          require_epoch_boundary: true,
          sleep_window_end: current.sleep_window_end
        }
      );
    if (!checkpoint || checkpoint.ok !== true) {
      throw new Error(
        checkpoint && checkpoint.error
          ? checkpoint.error
          : 'nightly training did not reach a full epoch boundary'
      );
    }
    current = checkpoint.session || current;
  }

  if (current.resource_entered === true) {
    const restored =
      await runtimeClient.exitTrainingResource(
        'manual_code_run_now_override',
        config
      );
    if (!restored || restored.ok !== true) {
      throw new Error(
        'nightly training resource could not be released ' +
        'for manual code Run Now'
      );
    }
    current = sessionModule.setSessionResourceEntered(
      current,
      false,
      config
    );
  }

  current = sessionModule.writeSession({
    ...current,
    status: 'paused_for_manual_code_run_now',
    manual_code_override_active: true,
    manual_code_override_started_at: nowIso(),
    updated_at: nowIso()
  }, config);

  updateStatus({
    state: 'starting',
    phase: 'manual_code_run_now_override',
    current_container: null,
    training_resource_mode: 'idle',
    gpu_owner: null
  }, config);

  appendAudit('nightly_training_paused_for_manual_code', {
    run_id: current.run_id,
    completed_epochs:
      Number(current.completed_epochs || 0),
    rem_cycles_completed:
      Number(current.rem_cycles_completed || 0)
  }, config);

  return Object.freeze({
    ok: true,
    paused: true,
    reason: 'manual_code_run_now_override',
    session: current
  });
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

// A candidate is actively being promoted into production — the codebase is
// changing underneath us, so a new cycle's snapshot would be inconsistent.
// This must always block a new cycle.
function promotionInProgress(config) {
  return listCandidates(config).some((candidate) =>
    ['approved', 'validating', 'deploying'].includes(candidate.status)
  );
}

// How many candidates are waiting for the Maker to review them. These do NOT
// block new cycles until the queue reaches max_pending_review_candidates, so
// the Maker returns to a batch of candidates instead of a single one.
function pendingReviewCount(config) {
  return listCandidates(config).filter(
    (candidate) => candidate.status === 'pending_review'
  ).length;
}

function pendingReviewQueueFull(config) {
  return pendingReviewCount(config) >= config.max_pending_review_candidates;
}

// Retained for backward compatibility: true when any candidate is pending
// review or being promoted.
function pendingCandidateExists(config) {
  return (
    promotionInProgress(config) || pendingReviewCount(config) > 0
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
      objective: status.current_objective || config.default_objective,
      kind: status.current_run_kind || config.default_rsi_run_kind,
      candidate_type: status.current_candidate_type || null
    });
  }
  return fileRequest;
}

async function runCycle(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  if (promotionInProgress(config)) {
    updateStatus({
      state: 'promoting',
      phase: 'awaiting_promotion_completion'
    }, config);
    return {
      ok: false,
      skipped: true,
      reason: 'promotion_in_progress'
    };
  }

  const runKind = normalizeRunKind(options.kind, config);
  const candidateType = candidateTypeForKind(runKind, config);
  if (runKind === 'training') {
    // training_cycle_runner_injection_precedes_night_routing
    if (typeof options.training_cycle_runner === 'function') {
      return options.training_cycle_runner({
        ...options,
        config,
        kind: runKind,
        candidate_type: candidateType
      });
    }
    const { isWithinSleepWindow } = require('../chat/sleep-cycle.cjs');
    if (isWithinSleepWindow(new Date())) {
      const {
        getProductionNightlyTrainingCoordinator
      } = require('./training/training-scheduler.cjs');
      const coordinator = getProductionNightlyTrainingCoordinator();
      const result = await coordinator.reconcile({ now: new Date() });
      updateStatus({
        state: 'training',
        phase: 'training_request_joined_nightly_session',
        current_run_kind: 'training',
        current_candidate_type: candidateType,
        current_objective: options.objective || config.nightly_training_default_objective,
        manual_run_pending: false,
        manual_run_request_id: options.manual_request_id || null,
        manual_run_acknowledged_at: options.manual_request_id ? nowIso() : null
      }, config);
      appendAudit('training_request_joined_nightly_session', {
        request_id: options.manual_request_id || null,
        objective: options.objective || null,
        session_run_id: result && result.session && result.session.run_id || null,
        action: result && result.action || null
      }, config);
      return Object.freeze({
        ok: true,
        joined_nightly_session: true,
        candidate_created: false,
        action: result && result.action || null,
        session_run_id: result && result.session && result.session.run_id || null
      });
    }
    return (options.training_cycle_runner || runTrainingCycle)({
      ...options,
      config,
      kind: runKind,
      candidate_type: candidateType
    });
  }
  if (
    options.force !== true &&
    automaticNightCycleOwnsWorker(
      config,
      options.now || new Date(),
      options
    )
  ) {
    updateStatus({
      state: 'training',
      phase: 'automatic_night_code_cycle_blocked',
      current_run_id: null,
      current_container: null,
      current_run_kind: 'training',
      current_candidate_type: 'model_adapter',
      current_objective:
        config.nightly_training_default_objective,
      last_error: null
    }, config);
    appendAudit('automatic_night_code_cycle_blocked', {
      requested_kind: runKind,
      requested_objective: options.objective || null
    }, config);
    return Object.freeze({
      ok: false,
      skipped: true,
      reason: 'automatic_night_training_only'
    });
  }

  const snapshot = createSourceSnapshot({ config });
  updateStatus({
    state: 'researching',
    phase: 'snapshot_ready',
    current_run_id: snapshot.run_id,
    current_objective: options.objective || null,
    current_run_kind: runKind,
    current_candidate_type: candidateType,
    last_cycle_started_at: nowIso(),
    last_error: null,
    failure_latched_at: null
  }, config);
  touchWorkerHeartbeat(config);

  const execution = runSandbox(snapshot, {
    config,
    objective: options.objective,
    kind: runKind
  });
  let preemptReason = null;
  const cycleStartMs = Date.now();
  try {
    await execution.wait_for_container_start();
    if (options.manual_request_id) {
      const acknowledgedAt = nowIso();
      updateStatus({
        manual_run_pending: false,
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
    const nowMs = Date.now();
    const wallClockBudgetMs = Math.min(
      Number(config.iteration_wall_clock_budget_ms) || Number.MAX_SAFE_INTEGER,
      Number(config.agent_run_wall_clock_budget_ms) || Number.MAX_SAFE_INTEGER
    );
    if (
      preemptReason === null &&
      Number.isFinite(wallClockBudgetMs) &&
      wallClockBudgetMs > 0 &&
      nowMs - cycleStartMs > wallClockBudgetMs
    ) {
      preemptReason = 'agent_run_wall_clock_budget_exceeded';
      stopCurrentContainer(preemptReason, config);
      return;
    }
    if (
      options.force !== true &&
      automaticNightCycleOwnsWorker(
        config,
        new Date()
      )
    ) {
      preemptReason = 'automatic_code_crossed_into_night';
      stopCurrentContainer(
        'automatic_code_crossed_into_night',
        config
      );
      return;
    }

    const status = readStatus(config);
    updateStatus({}, config);
    touchWorkerHeartbeat(config);
    touchSandboxHeartbeat(config, snapshot.run_id);
    const lastSandboxHeartbeat = readSandboxHeartbeat(config);
    const lastSandboxMs = lastSandboxHeartbeat ? Date.parse(lastSandboxHeartbeat.observed_at || '') : null;
    const stallMs = lastSandboxMs ? (nowMs - lastSandboxMs) : 0;
    const stalled =
      stallMs > config.shell_command_stalled_threshold_ms;
    const runtime = readRuntimeStatus(config);
    const activeNightlyPolicy =
      evaluateNightlyPolicy(config);
    const eligibility =
      activeNightlyPolicy.code_sandbox_allowed
        ? idleEligibility(
            runtime,
            status,
            config,
            options.force === true
          )
        : {
            eligible: false,
            reason: 'nightly_hf_cycle'
          };
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
      current_command_elapsed_ms: nowMs - cycleStartMs,
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
  const executionStatus = {
    log_file: execution.log_file,
    run_id: snapshot.run_id
  };

  if (classification.preempted) {
    if (isNoCandidateStopReason(classification.reason)) {
      const summary = execution.read_error_tail();
      const completedAt = nowIso();
      const message = summary
        ? classification.reason + '\n\n' + summary
        : classification.reason;
      updateStatus(
        noCandidateStatusPatch(message, executionStatus, completedAt),
        config
      );
      appendAudit(
        'cycle_no_candidate',
        {
          run_id: snapshot.run_id,
          exit_code: exit.code,
          signal: exit.signal,
          reason: classifyNoCandidateReason(message),
          preempted: true,
          sandbox_log_file: execution.log_file
        },
        config
      );
      try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
      try {
        writeCycleMemory({
          run_id: snapshot.run_id,
          objective: options.objective || null,
          outcome: 'no_candidate',
          reason: classifyNoCandidateReason(message),
          importance: 0.55
        });
      } catch (_) {}
      return {
        ok: false,
        no_candidate: true,
        reason: classifyNoCandidateReason(message)
      };
    }
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
    try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
    try {
      writeCycleMemory({
        run_id: snapshot.run_id,
        objective: options.objective || null,
        outcome: 'preempted',
        reason: classification.reason,
        importance: 0.40
      });
    } catch (_) {}
    return {
      ok: false,
      preempted: true,
      reason: classification.reason
    };
  }

  const cycleObjective = options.objective || null;

  if (exit.code !== 0 && exit.code !== 137) {
    const summary = execution.read_error_tail();
    const base = exit.error
      ? exit.error.message
      : 'sandbox exited with status ' + exit.code +
        (exit.signal ? ' signal ' + exit.signal : '');
    const message = summary ? base + '\n\n' + summary : base;
    const failedAt = nowIso();
    if (isNoCandidateSandboxFailure(message)) {
      updateStatus(noCandidateStatusPatch(message, executionStatus, failedAt), config);
      appendAudit(
        'cycle_no_candidate',
        {
          run_id: snapshot.run_id,
          exit_code: exit.code,
          signal: exit.signal,
          reason: classifyNoCandidateReason(message),
          error: message.slice(0, 800),
          sandbox_log_file: execution.log_file
        },
        config
      );
      try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
      try {
        writeCycleMemory({
          run_id: snapshot.run_id,
          objective: cycleObjective,
          outcome: 'no_candidate',
          reason: classifyNoCandidateReason(message),
          importance: 0.55
        });
      } catch (_) {}
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
    try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
    try {
      writeCycleMemory({
        run_id: snapshot.run_id,
        objective: cycleObjective,
        outcome: 'cycle_failed',
        reason: message.slice(0, 400),
        importance: 0.50
      });
    } catch (_) {}
    return { ok: false, error: message };
  }

  const completionSummary = execution.read_error_tail();
  if (exit.code === 0 && isNoCandidateSandboxFailure(completionSummary)) {
    const completedAt = nowIso();
    updateStatus(
      noCandidateStatusPatch(completionSummary, executionStatus, completedAt),
      config
    );
    appendAudit('cycle_no_candidate', {
      run_id: snapshot.run_id,
      exit_code: exit.code,
      signal: exit.signal,
      reason: classifyNoCandidateReason(completionSummary),
      error: String(completionSummary || '').slice(0, 800),
      sandbox_log_file: execution.log_file
    }, config);
    try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
    try {
      writeCycleMemory({
        run_id: snapshot.run_id,
        objective: cycleObjective,
        outcome: 'no_candidate',
        reason: classifyNoCandidateReason(completionSummary),
        importance: 0.55
      });
    } catch (_) {}
    return {
      ok: false,
      no_candidate: true,
      controlled: true,
      error: completionSummary
    };
  }

  try { flushAgentMemoryOutbox(config.outbox_root, snapshot.run_id); } catch (_) {}
  const candidate = importOutbox(snapshot.run_id, config);
  try {
    writeCycleMemory({
      run_id: snapshot.run_id,
      objective: candidate.objective || cycleObjective,
      outcome: 'candidate_produced',
      reason: 'Candidate pending Maker review.',
      importance: 0.75
    });
  } catch (_) {}
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
    if (promotionInProgress(config)) {
      updateStatus({
        state: 'promoting',
        phase: 'awaiting_promotion_completion'
      }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }

    // single_night_scheduler_owns_worker_loop
    const queuedNightRequestForScheduler = readRunRequest(config);
    const manualNightOverrideQueued =
      queuedNightRequestForScheduler?.force === true;
    if (
      !manualNightOverrideQueued &&
      automaticNightCycleOwnsWorker(config, new Date())
    ) {
      if (!(
        status.current_run_kind === 'training' &&
        typeof status.phase === 'string' &&
        status.phase.startsWith('nightly_')
      )) {
        updateStatus({
          state: 'training',
          phase: 'nightly_scheduler_owns_worker_loop',
          current_run_kind: 'training',
          current_candidate_type: 'model_adapter',
          current_objective: config.nightly_training_default_objective,
          current_container: null
        }, config);
      }
      await wakeController.wait(config.poll_ms);
      continue;
    }


    // automatic_night_cycle_before_general_rsi
    const queuedNightRequest = readRunRequest(config);
    const queuedManualOverride =
      queuedNightRequest?.force === true;

    if (
      !queuedManualOverride &&
      automaticNightCycleOwnsWorker(
        config,
        new Date()
      )
    ) {
      try {
        const {
          getProductionNightlyTrainingCoordinator
        } = require(
          './training/training-scheduler.cjs'
        );
        const coordinator =
          getProductionNightlyTrainingCoordinator();
        await coordinator.reconcile({
          now: new Date()
        });
      } catch (error) {
        const message =
          error && error.stack
            ? error.stack
            : String(error && error.message || error);
        updateStatus({
          state: 'failed',
          phase: 'nightly_training_coordinator_failed',
          current_container: null,
          nightly_training_error: message,
          last_error: message,
          failure_latched_at: nowIso()
        }, config);
        appendAudit(
          'nightly_training_coordinator_failed',
          { error: message },
          config
        );
      }

      await wakeController.wait(config.poll_ms);
      continue;
    }

    const nightlyPolicy = evaluateNightlyPolicy(config);
    if (!nightlyPolicy.code_sandbox_allowed) {
      const blockedRequest = readRunRequest(config);

      if (blockedRequest) {
        clearRunRequest(config);
        appendAudit(
          'run_now_blocked_nightly_hf_cycle',
          {
            request_id: blockedRequest.request_id || null,
            kind: blockedRequest.kind || null,
            sleep_date: nightlyPolicy.sleep_date
          },
          config
        );
      }

      const nightlyPatch = {
        code_sandbox_available: false,
        run_now_block_reason: 'nightly_hf_cycle',
        manual_run_pending: false
      };

      if (!status.current_run_id && !status.current_container) {
        Object.assign(nightlyPatch, {
          state: 'waiting_for_idle',
          phase: 'nightly_hf_cycle',
          current_objective: null,
          current_run_kind: null,
          current_candidate_type: null
        });
      }

      updateStatus(nightlyPatch, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }

    updateStatus({
      code_sandbox_available: true,
      run_now_block_reason: null
    }, config);

    const fileRequest = readRunRequest(config);
    const request = resolveManualRunRequest(
      fileRequest,
      status,
      config
    );

    const manualNightCodeOverride = Boolean(
      request?.force === true &&
      normalizeRunKind(
        request.kind || config.default_rsi_run_kind,
        config
      ) === 'code' &&
      automaticNightCycleOwnsWorker(
        config,
        new Date()
      )
    );

    // Let the pending-review queue grow up to max_pending_review_candidates so
    // the Maker returns to a batch of candidates. A manual Run Now (force)
    // bypasses the queue cap; only active promotion blocks a forced run.
    if (request?.force !== true && pendingReviewQueueFull(config)) {
      updateStatus({
        state: 'pending_review',
        phase: 'awaiting_maker_decision',
        pending_review_count: pendingReviewCount(config)
      }, config);
      await wakeController.wait(config.poll_ms);
      continue;
    }

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
        manual_run_pending: true,
        manual_run_request_id: request.request_id || null,
        manual_run_acknowledged_at: null,
        current_objective:
          request.objective || config.default_objective,
        last_error: null,
        failure_latched_at: null
      }, config);
    }

    if (manualNightCodeOverride) {
      await pauseNightlyTrainingForManualCode(config);
    }

    clearRunRequest(config);
    try {
      await runCycle({
        config,
        force: request?.force === true,
        objective: request?.objective || '',
        kind: request?.kind || config.default_rsi_run_kind,
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
    // manualNightCodeOverride_resume_nightly_immediately
    if (manualNightCodeOverride) {
      continue;
    }
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
  pauseNightlyTrainingForManualCode,
  automaticNightCycleOwnsWorker,
  createServiceWakeController,
  idleEligibility,
  latestActivityMs,
  memoryAvailableMb,
  pendingCandidateExists,
  promotionInProgress,
  pendingReviewCount,
  pendingReviewQueueFull,
  readRuntimeStatus,
  resolveManualRunRequest,
  classifySandboxExit,
  classifyNoCandidateReason,
  isNoCandidateSandboxFailure,
  isNoCandidateStopReason,
  noCandidateStatusPatch,
  runCycle,
  serviceLoop,
  shouldPreemptActiveRun
};
