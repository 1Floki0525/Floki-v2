'use strict';

const path = require('node:path');

const { loadSelfImprovementConfig } = require('./config.cjs');
const { readStatus } = require('./store.cjs');
const { readNightlySession } = require('./training/nightly-training-session.cjs');
const { currentOwner } = require('./training/gpu-ownership.cjs');
const { readRemClaims } = require('./training/training-scheduler.cjs');
const { listAdapters } = require('./training/lineage.cjs');
const { loadSleepCycleState } = require('../chat/sleep-cycle.cjs');
const { readManualNapState } = require('../chat/manual-nap.cjs');

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
  const session = safeRead('nightly session status',
    () => (dependencies.readNightlySession || readNightlySession)(config),
    null,
    dependencyErrors
  );
  const owner = safeRead('GPU ownership status',
    () => (dependencies.currentOwner || currentOwner)(config),
    null,
    dependencyErrors
  );
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
    session && session.training_error
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
  const activeRun = Boolean(
    base.current_run_id ||
    base.current_container ||
    activeControlStates.has(controlState)
  );
  const activeKind =
    base.current_run_kind ||
    (
      base.current_candidate_type === 'model_adapter' ||
      base.training_resource_mode === 'active'
        ? 'training'
        : config.default_rsi_run_kind
    );
  const codeSandboxActive =
    activeRun && activeKind === 'code';
  const trainingRunActive =
    activeRun && activeKind === 'training';

  return Object.freeze({
    ...base,
    active_run_kind: base.current_run_kind || config.default_rsi_run_kind,
    active_role: base.current_role || base.role || null,
    active_tool: base.current_tool || base.current_command || null,
    resource_mode: base.training_resource_mode || (
      owner === 'ollama_cognition' ? 'live_cognition' :
      owner === 'hf_training' ? 'training' :
      owner === 'hf_rem_inference' ? 'nightly_rem' :
      owner === 'vision' ? 'vision' : 'idle'
    ),
    gpu_owner: owner,
    loaded_models: loadedModelsForOwner(owner, config, session, lineage),
    providers: Object.freeze({
      live_cognition: config.live_cognition_provider,
      code_improvement: config.code_improvement_provider,
      manual_training: config.manual_training_provider,
      nightly_training: config.nightly_training_provider,
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
        base.worker_running === true &&
        base.model_proxy_ready === true &&
        base.paused !== true &&
        !activeRun,
      can_run_training:
        config.manual_training_enabled === true &&
        base.worker_running === true &&
        base.paused !== true &&
        !trainingRunActive,
      can_stop_code: codeSandboxActive,
      can_abort_training: trainingRunActive,
      can_abort: activeRun,
      training_preempts_code_sandbox: true,
      can_pause: base.worker_running === true
    })
  });
}

module.exports = {
  buildSelfImprovementUiStatus,
  latestApprovedAdapter,
  loadedModelsForOwner,
  nextNightlyRem
};
