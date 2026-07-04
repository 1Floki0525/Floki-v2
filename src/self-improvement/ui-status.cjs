'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadSelfImprovementConfig } = require('./config.cjs');
const { readStatus } = require('./store.cjs');
const { readNightlySession } = require('./training/nightly-training-session.cjs');
const { currentOwner } = require('./training/gpu-ownership.cjs');
const { observeTrainingReality } = require('./training/training-observation.cjs');
const { readRemClaims } = require('./training/training-scheduler.cjs');
const { listAdapters } = require('./training/lineage.cjs');
const { loadSleepCycleState } = require('../chat/sleep-cycle.cjs');
const { readManualNapState } = require('../chat/manual-nap.cjs');
const {
  evaluateNightlyPolicy
} = require('./nightly-policy.cjs');

function safeRead(label, fn, fallback, errors) {
  try {
    const value = fn();
    return value == null ? fallback : value;
  } catch (error) {
    errors.push(label + ': ' + (error && error.message ? error.message : String(error)));
    return fallback;
  }
}

function latestApprovedAdapter(adapters) {
  const rows = (Array.isArray(adapters) ? adapters : [])
    .filter((row) => row && (
      row.approval_status === 'approved' ||
      row.activation_status === 'active'
    ))
    .sort((a, b) => Number(a.version_number || 0) - Number(b.version_number || 0));
  const active = rows.filter((row) => row.activation_status === 'active');
  return (active.length ? active : rows).slice(-1)[0] || null;
}

function nextNightlyRem(sleepState) {
  const cycles = sleepState && Array.isArray(sleepState.rem_cycles)
    ? sleepState.rem_cycles
    : [];
  const next = cycles.find((cycle) => (
    cycle &&
    ['pending', 'dreaming'].includes(String(cycle.status || ''))
  ));
  if (!next) return null;
  return Object.freeze({
    cycle_number: Number(next.cycle_number),
    scheduled_at: next.scheduled_at || null,
    status: next.status || null,
    stage: next.stage || null
  });
}

function latestAgentTelemetry(base, config, nowMs = Date.now()) {
  const file = base && base.last_sandbox_log_file
    ? String(base.last_sandbox_log_file)
    : '';
  if (!file) return null;
  let content = '';
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const start = Math.max(0, Number(stat.size || 0) - 262144);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(0, Number(stat.size || 0) - start));
      if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, start);
      content = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_error) {
    return null;
  }
  let latest = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT')) continue;
    let record;
    try { record = JSON.parse(line); } catch (_error) { continue; }
    if (record?.type !== 'progress_heartbeat') continue;
    const detail = record.detail || {};
    if (base.current_run_id && detail.run_id && detail.run_id !== base.current_run_id) continue;
    latest = {
      observed_at: record.created_at || detail.telemetry_observed_at || null,
      role: detail.current_role || null,
      tool: detail.current_tool || null,
      resource_mode: detail.resource_mode || null,
      gpu_owner: detail.gpu_owner || null,
      event: detail.event || null,
      iteration: detail.iteration ?? null,
      phase: detail.phase || null
    };
  }
  if (!latest) return null;
  const observedMs = Date.parse(latest.observed_at || '');
  const staleMs = Number(
    config.sandbox_heartbeat_stale_ms ||
    config.worker_heartbeat_stale_ms ||
    30000
  );
  const stale =
    !Number.isFinite(observedMs) ||
    (staleMs > 0 && nowMs - observedMs > staleMs);
  return Object.freeze({
    ...latest,
    stale,
    source: 'sandbox_agent_audit'
  });
}

function normalizeResourceMode(value, activeRun) {
  const mode = String(value || '').trim();
  if ([
    'cognition/model inference',
    'CPU/tool execution',
    'filesystem/I/O',
    'network/research',
    'GPU/training',
    'idle'
  ].includes(mode)) return mode;
  if (mode === 'active') return 'GPU/training';
  if (mode === 'entering' || mode === 'restoring' || mode === 'prepared') {
    return 'CPU/tool execution';
  }
  return activeRun ? 'CPU/tool execution' : 'idle';
}

function loadedModelsForOwner(owner, config, session, lineage) {
  if (owner === 'ollama_cognition') {
    return Object.freeze([Object.freeze({
      provider: config.live_cognition_provider,
      model: config.model.name,
      purpose: 'live_cognition',
      authority: 'gpu_ownership'
    })]);
  }
  if (owner === 'hf_training') {
    return Object.freeze([Object.freeze({
      provider: config.manual_training_provider,
      model: path.basename(String(config.hf_master_path || '')),
      purpose: 'qlora_training',
      adapter_id: session && session.adapter_id || null,
      authority: 'gpu_ownership'
    })]);
  }
  if (owner === 'hf_rem_inference') {
    return Object.freeze([Object.freeze({
      provider: config.nightly_rem_provider,
      model: lineage && lineage.adapter_id
        ? lineage.adapter_id
        : path.basename(String(config.hf_master_path || '')),
      purpose: 'nightly_rem_inference',
      adapter_id: lineage && lineage.adapter_id || null,
      authority: 'gpu_ownership'
    })]);
  }
  if (owner === 'vision') {
    return Object.freeze([Object.freeze({
      provider: config.vision_provider,
      model: null,
      purpose: 'live_vision',
      authority: 'gpu_ownership'
    })]);
  }
  return Object.freeze([]);
}

function buildSelfImprovementUiStatus(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const dependencies = options.dependencies || {};
  const base = (dependencies.readStatus || readStatus)(config);
  const dependencyErrors = [];
  const nightlyPolicy = safeRead(
    'nightly HF lifecycle policy',
    () => (
      dependencies.evaluateNightlyPolicy ||
      evaluateNightlyPolicy
    )(
      config,
      options.now || new Date()
    ),
    {
      active: false,
      chat_available: true,
      code_sandbox_allowed: true,
      manual_training_allowed: true,
      run_now_allowed: true,
      run_now_block_reason: null
    },
    dependencyErrors
  );
  const session = safeRead('nightly session status',
    () => (dependencies.readNightlySession || readNightlySession)(config),
    null,
    dependencyErrors
  );
  const trainingReality = safeRead(
    'observed training reality',
    () => (dependencies.observeTrainingReality || observeTrainingReality)({
      config,
      session,
      reconcile_stale_owner: true,
      now_ms: options.now instanceof Date ? options.now.getTime() : Date.now()
    }),
    {
      phase: session && session.active === true ? 'waiting' : 'inactive',
      resource_mode: session && session.active === true ? 'waiting' : 'inactive',
      observed_gpu_owner: null,
      live_training: false,
      live_rem: false,
      stale_gpu_owner: false,
      stale_owner_reconciled: false,
      active_hf_model: false,
      error: null
    },
    dependencyErrors
  );
  const owner = trainingReality.observed_gpu_owner;
  const claimsRecord = safeRead('REM claim status',
    () => (dependencies.readRemClaims || readRemClaims)(config),
    { claims: {} },
    dependencyErrors
  );
  const adapters = safeRead('adapter lineage status',
    () => (dependencies.listAdapters || listAdapters)(config),
    [],
    dependencyErrors
  );
  const sleepState = safeRead('sleep-cycle status',
    () => (dependencies.loadSleepCycleState || loadSleepCycleState)(),
    null,
    dependencyErrors
  );
  const manualNap = safeRead('manual-nap status',
    () => (dependencies.readManualNapState || readManualNapState)(),
    null,
    dependencyErrors
  );
  const lineage = latestApprovedAdapter(adapters);
  const claims = claimsRecord && claimsRecord.claims &&
    typeof claimsRecord.claims === 'object'
    ? Object.values(claimsRecord.claims)
    : [];
  const completedClaims = claims.filter((claim) => claim.status === 'complete');
  const failedClaims = claims.filter((claim) => claim.status === 'failed');
  const nextRem = nextNightlyRem(sleepState);
  const errors = [
    ...dependencyErrors,
    base.last_error,
    base.nightly_training_error,
    base.nightly_rem_error,
    base.wake_restoration_error,
    session && session.training_error,
    trainingReality.error,
    trainingReality.reconciliation_error
  ].filter(Boolean);
  const rawTrainingProgress = base.training_progress || (session ? {
    run_id: session.run_id,
    sleep_date: session.sleep_date,
    segment_number: Number(session.segment_number || 0),
    status: session.status || null,
    latest_checkpoint: session.latest_checkpoint || null,
    started_at: session.segment_started_at || session.created_at || null
  } : null);
  const trainingProgress = rawTrainingProgress ? Object.freeze({
    ...rawTrainingProgress,
    latest_checkpoint: rawTrainingProgress.latest_checkpoint
      ? path.basename(String(rawTrainingProgress.latest_checkpoint))
      : null
  }) : null;

  const controlState = String(base.state || '');
  const activeControlStates = new Set([
    'queued',
    'starting',
    'researching',
    'experimenting',
    'verifying',
    'training'
  ]);
  const codeRunActive = Boolean(
    (base.current_run_kind || config.default_rsi_run_kind) === 'code' &&
    (
      base.current_run_id ||
      base.current_container ||
      activeControlStates.has(controlState)
    )
  );
  const trainingSessionOpen = Boolean(
    session && session.active === true && session.finalized !== true && session.aborted !== true
  );
  const activeRun = Boolean(
    codeRunActive ||
    trainingSessionOpen ||
    trainingReality.live_training === true ||
    trainingReality.live_rem === true
  );
  const activeKind = trainingSessionOpen || trainingReality.live_training || trainingReality.live_rem
    ? 'training'
    : base.current_run_kind || config.default_rsi_run_kind;
  const codeSandboxActive =
    activeRun && activeKind === 'code';
  const trainingRunActive =
    activeRun && activeKind === 'training';

  // Truthful cycle attribution: mirror the objective_source values written by
  // the sandbox/worker pipeline ('maker_requested' | 'floki_selected'). Never
  // claim a Floki-selected cycle while idle.
  const activeCycleType = activeRun
    ? (
        base.objective_source === 'maker_requested' ||
        base.objective_source === 'maker'
          ? 'maker_requested'
          : 'floki_selected'
      )
    : null;

  // Truthful operational phase: a persisted 'nightly_wake_restored' (or any
  // stale nightly_wake_* phase) describes a past transition, not the current
  // daytime state.
  const basePhase = base.phase == null ? '' : String(base.phase);
  const currentPhase = trainingSessionOpen
    ? trainingReality.phase
    : activeRun
      ? (base.phase || null)
      : (!basePhase || basePhase.startsWith('nightly_wake'))
        ? 'daytime_idle'
        : basePhase;

  const loadedModels = loadedModelsForOwner(owner, config, session, lineage);
  const rawTelemetry = latestAgentTelemetry(
    base,
    config,
    options.now ? Number(new Date(options.now)) : Date.now()
  );
  const telemetry = activeRun ? rawTelemetry : null;
  const freshTelemetry = telemetry && telemetry.stale !== true ? telemetry : null;
  const effectiveRole = activeRun
    ? (freshTelemetry?.role || base.current_role || base.role || null)
    : null;
  const effectiveTool = activeRun
    ? (freshTelemetry?.tool || base.current_tool || base.current_command || null)
    : null;
  const effectiveResourceMode = normalizeResourceMode(
    freshTelemetry?.resource_mode || base.resource_mode || base.training_resource_mode,
    activeRun
  );
  const effectiveGpuOwner =
    owner ||
    freshTelemetry?.gpu_owner ||
    (
      activeRun &&
      (
        effectiveResourceMode === 'cognition/model inference' ||
        effectiveTool === 'model_turn' ||
        effectiveTool === 'selection_model_turn'
      )
        ? 'self-improvement/cognition'
        : null
    );

  // GPU truth model: the RTX card is the DEVICE. Ownership is either an
  // explicit exclusive ledger owner or the honest shared daytime allocation.
  const gpuWorkloads = owner
    ? Object.freeze(loadedModels.map((model) => Object.freeze({
        workload: model.purpose,
        provider: model.provider
      })))
    : nightlyPolicy.active === true || trainingSessionOpen
      ? Object.freeze([])
      : Object.freeze([
          Object.freeze({
            workload: 'live_cognition',
            provider: config.live_cognition_provider
          }),
          Object.freeze({
            workload: 'live_vision',
            provider: config.vision_provider
          })
        ]);

  return Object.freeze({
    ...base,
    state: trainingSessionOpen ? trainingReality.phase : base.state,
    phase: currentPhase,
    nightly_hf_cycle: nightlyPolicy,
    active_run: Boolean(activeRun),
    active_run_kind: activeRun ? activeKind : null,
    next_run_kind: config.default_rsi_run_kind,
    active_goal: activeRun ? (base.current_objective || null) : null,
    next_goal: config.default_objective,
    active_cycle_type: activeCycleType,
    active_role: effectiveRole,
    active_tool: effectiveTool,
    telemetry: telemetry ? Object.freeze(telemetry) : null,
    telemetry_stale: telemetry ? telemetry.stale === true : false,
    telemetry_generation: freshTelemetry?.observed_at || base.last_heartbeat_at || null,
    current_phase: currentPhase,
    last_transition: Object.freeze({
      phase: base.last_transition || null,
      at: base.last_transition_at || null
    }),
    gpu_device: config.training_expected_gpu_name,
    gpu_workload_owner: owner ||
      (activeRun && effectiveGpuOwner ? effectiveGpuOwner : null) ||
      (nightlyPolicy.active === true || trainingSessionOpen ? null : 'daytime_shared_cognition'),
    gpu_workloads: gpuWorkloads,
    exclusive_ownership_lock: owner,
    resource_mode: trainingSessionOpen || trainingReality.live_training || trainingReality.live_rem
      ? trainingReality.resource_mode
      : activeRun && freshTelemetry?.resource_mode
        ? effectiveResourceMode
        : base.training_resource_mode || (
            owner === 'ollama_cognition' ? 'live_cognition' :
            owner === 'vision' ? 'vision' : 'idle'
          ),
    gpu_owner: effectiveGpuOwner,
    exclusive_gpu_owner: owner,
    loaded_models: loadedModels,
    providers: Object.freeze({
      live_cognition: config.live_cognition_provider,
      code_improvement: config.code_improvement_provider,
      manual_training: config.manual_training_provider,
      nightly_training: config.nightly_training_provider,
      nightly_chat: config.nightly_chat_provider,
      nightly_rem: config.nightly_rem_provider,
      manual_nap_rem: config.manual_nap_rem_provider
    }),
    hf_state: Object.freeze({
      active: ['hf_training', 'hf_rem_inference'].includes(owner),
      mode: owner === 'hf_training'
        ? 'training'
        : owner === 'hf_rem_inference'
          ? 'rem_inference'
          : 'idle',
      master_model: path.basename(String(config.hf_master_path || '')),
      session_run_id: session && session.run_id || null,
      session_status: session && session.status || null,
      segment_number: Number(session && session.segment_number || 0),
      latest_checkpoint: session && session.latest_checkpoint
        ? path.basename(String(session.latest_checkpoint))
        : null,
      current_container: session && session.current_container || null
    }),
    lineage: Object.freeze({
      approved_adapter_count: adapters.filter((row) => row.approval_status === 'approved').length,
      active_adapter_id: lineage && lineage.adapter_id || null,
      active_version: lineage && lineage.version || null,
      rollback_target: lineage && lineage.rollback_target || null,
      candidate_adapter_id: session && session.adapter_id || null,
      candidate_id: session && session.candidate_id || null
    }),
    training_truth: Object.freeze(trainingReality),
    nightly_cycle: Object.freeze({
      active: trainingSessionOpen,
      aborted: Boolean(session && session.aborted),
      finalized: Boolean(session && session.finalized),
      current_epoch: Number(session && session.completed_epochs || 0) +
        (session && session.current_container ? 1 : 0),
      epoch_state: trainingReality.phase === 'training'
        ? 'running'
        : trainingReality.phase === 'waiting_for_rem'
          ? 'complete'
          : trainingReality.phase,
      completed_epochs: Number(session && session.completed_epochs || 0),
      current_rem_cycle: trainingReality.phase === 'rem_inference'
        ? Number(session && session.rem_cycles_completed || 0) + 1
        : null,
      completed_rem_cycles: Number(session && session.rem_cycles_completed || 0),
      next_action: trainingReality.phase === 'waiting_for_rem' || trainingReality.phase === 'rem_inference'
        ? 'REM dream'
        : 'training epoch',
      one_candidate_per_night: true,
      wake_at: session && session.sleep_window_end || null,
      error: trainingReality.error || session && session.training_error || null
    }),
    observed_state: trainingReality.phase,
    observed_resource_mode: trainingReality.resource_mode,
    observed_gpu_owner: owner,
    training_progress: trainingProgress,
    rem_coordination: Object.freeze({
      current_cycle: Number(base.current_rem_cycle || 0) || null,
      next_rem: nextRem,
      completed_claims: completedClaims.length,
      failed_claims: failedClaims.length,
      manual_nap_active: manualNap && manualNap.active === true,
      manual_nap_provider: config.manual_nap_rem_provider,
      nightly_provider: config.nightly_rem_provider
    }),
    restoration: session && session.restoration || null,
    surfaced_errors: Object.freeze(errors),
    ui_limits: Object.freeze({
      candidate_render_limit: config.rsi_ui_candidate_render_limit,
      terminal_event_limit: config.rsi_terminal_event_limit,
      terminal_chunk_bytes: config.rsi_terminal_chunk_bytes,
      terminal_window_bytes: config.rsi_terminal_window_bytes,
      terminal_bootstrap_poll_ms: config.rsi_terminal_bootstrap_poll_ms,
      terminal_at_bottom_threshold_px: config.rsi_terminal_at_bottom_threshold_px,
      terminal_poll_ms: config.rsi_terminal_poll_ms,
      terminal_initial_activity_limit: config.rsi_terminal_initial_activity_limit,
      terminal_incremental_activity_limit: config.rsi_terminal_incremental_activity_limit,
      terminal_safe_string_max_chars: config.rsi_terminal_safe_string_max_chars,
      terminal_output_max_lines: config.rsi_terminal_output_max_lines,
      terminal_output_max_line_chars: config.rsi_terminal_output_max_line_chars,
      terminal_code_max_lines: config.rsi_terminal_code_max_lines,
      terminal_code_max_line_chars: config.rsi_terminal_code_max_line_chars,
      terminal_command_max_chars: config.rsi_terminal_command_max_chars,
      terminal_output_max_chars: config.rsi_terminal_output_max_chars,
      terminal_success_output_max_lines: config.rsi_terminal_success_output_max_lines,
      terminal_failure_output_max_lines: config.rsi_terminal_failure_output_max_lines,
      terminal_diff_max_chars: config.rsi_terminal_diff_max_chars,
      terminal_selection_error_max_chars: config.rsi_terminal_selection_error_max_chars,
      terminal_selection_error_max_lines: config.rsi_terminal_selection_error_max_lines,
      terminal_selection_error_line_max_chars: config.rsi_terminal_selection_error_line_max_chars,
      terminal_summary_max_chars: config.rsi_terminal_summary_max_chars
    }),
    controls: Object.freeze({
      can_run_code:
        nightlyPolicy.run_now_allowed === true &&
        base.worker_running === true &&
        base.model_proxy_ready === true &&
        base.paused !== true &&
        !activeRun,
      can_run_training:
        nightlyPolicy.manual_training_allowed === true &&
        config.manual_training_enabled === true &&
        base.worker_running === true &&
        base.paused !== true &&
        !trainingRunActive,
      can_stop_code: codeSandboxActive,
      can_abort_training: trainingRunActive,
      can_abort: activeRun,
      training_preempts_code_sandbox: true,
      can_pause: base.worker_running === true,
      chat_available:
        nightlyPolicy.chat_available === true,
      run_now_block_reason:
        nightlyPolicy.run_now_block_reason
    })
  });
}

module.exports = {
  buildSelfImprovementUiStatus,
  latestApprovedAdapter,
  loadedModelsForOwner,
  nextNightlyRem
};
