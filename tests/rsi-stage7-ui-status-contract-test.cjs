'use strict';

const assert = require('node:assert/strict');
const {
  buildSelfImprovementUiStatus
} = require('../src/self-improvement/ui-status.cjs');

const config = {
  default_rsi_run_kind: 'code',
  manual_training_enabled: true,
  model: { name: 'configured-cognition-model' },
  hf_master_path: '/tmp/hf-master',
  live_cognition_provider: 'ollama',
  code_improvement_provider: 'ollama',
  manual_training_provider: 'huggingface',
  nightly_training_provider: 'huggingface',
  nightly_rem_provider: 'huggingface',
  manual_nap_rem_provider: 'ollama',
  vision_provider: 'vision',
  rsi_ui_candidate_render_limit: 200,
  rsi_terminal_event_limit: 3000,
  rsi_terminal_at_bottom_threshold_px: 60,
  rsi_terminal_poll_ms: 2000,
  rsi_terminal_initial_activity_limit: 250,
  rsi_terminal_incremental_activity_limit: 200,
  rsi_terminal_safe_string_max_chars: 200,
  rsi_terminal_output_max_lines: 25,
  rsi_terminal_output_max_line_chars: 160,
  rsi_terminal_code_max_lines: 400,
  rsi_terminal_code_max_line_chars: 240,
  rsi_terminal_command_max_chars: 400,
  rsi_terminal_output_max_chars: 12000,
  rsi_terminal_success_output_max_lines: 40,
  rsi_terminal_failure_output_max_lines: 50,
  rsi_terminal_diff_max_chars: 60000,
  rsi_terminal_selection_error_max_chars: 2000,
  rsi_terminal_selection_error_max_lines: 10,
  rsi_terminal_selection_error_line_max_chars: 150,
  rsi_terminal_summary_max_chars: 200
};

const status = buildSelfImprovementUiStatus({
  config,
  dependencies: {
    readStatus: () => ({
      worker_running: true,
      paused: false,
      current_run_id: 'nightly-training-1',
      current_run_kind: 'training',
      current_container: 'training-container',
      phase: 'nightly_training_segment_running',
      current_objective: 'nightly training',
      training_resource_mode: 'active',
      training_progress: {
        run_id: 'nightly-training-1',
        status: 'training',
        percent: 42,
        latest_checkpoint: '/tmp/base-checkpoint-40'
      }
    }),
    readNightlySession: () => ({
      run_id: 'nightly-training-1',
      status: 'training',
      segment_number: 2,
      latest_checkpoint: '/tmp/checkpoint-50',
      current_container: 'training-container',
      adapter_id: 'adapter-v2',
      candidate_id: null,
      restoration: null
    }),
    currentOwner: () => 'hf_training',
    readRemClaims: () => ({
      claims: {
        one: { status: 'complete' },
        two: { status: 'failed' }
      }
    }),
    listAdapters: () => [{
      adapter_id: 'adapter-v1',
      version: 'v1',
      version_number: 1,
      approval_status: 'approved',
      activation_status: 'active',
      rollback_target: 'hf_master'
    }],
    loadSleepCycleState: () => ({
      rem_cycles: [{
        cycle_number: 8,
        status: 'pending',
        stage: 'pending',
        scheduled_at: '2026-06-28T03:20:00.000Z'
      }]
    }),
    readManualNapState: () => ({ active: false })
  }
});

assert.equal(status.active_run_kind, 'training');
assert.equal(status.gpu_owner, 'hf_training');
assert.equal(status.resource_mode, 'active');
assert.equal(status.loaded_models[0].provider, 'huggingface');
assert.equal(status.hf_state.segment_number, 2);
assert.equal(status.hf_state.master_model, 'hf-master');
assert.equal(status.hf_state.latest_checkpoint, 'checkpoint-50');
assert.equal(status.training_progress.latest_checkpoint, 'base-checkpoint-40');
assert.equal(status.training_progress.percent, 42);
assert.equal(JSON.stringify(status).includes('/tmp/base-checkpoint-40'), false);
assert.equal(JSON.stringify(status).includes('/tmp/checkpoint-50'), false);
assert.equal(JSON.stringify(status).includes('/tmp/hf-master'), false);
assert.equal(status.lineage.active_adapter_id, 'adapter-v1');
assert.equal(status.rem_coordination.next_rem.cycle_number, 8);
assert.equal(status.rem_coordination.completed_claims, 1);
assert.equal(status.rem_coordination.failed_claims, 1);
assert.equal(status.controls.can_run_code, false);
assert.equal(status.controls.can_abort, true);
assert.equal(status.providers.manual_nap_rem, 'ollama');
assert.equal(status.providers.nightly_rem, 'huggingface');
assert.equal(status.ui_limits.candidate_render_limit, 200);
assert.equal(status.ui_limits.terminal_poll_ms, 2000);

const errored = buildSelfImprovementUiStatus({
  config,
  dependencies: {
    readStatus: () => ({ worker_running: true, paused: false, model_proxy_ready: true }),
    readNightlySession: () => { throw new Error('malformed session'); },
    currentOwner: () => null,
    readRemClaims: () => { throw new Error('malformed claims'); },
    listAdapters: () => [],
    loadSleepCycleState: () => null,
    readManualNapState: () => null
  }
});
assert.equal(errored.surfaced_errors.some((value) => value.includes('malformed session')), true);
assert.equal(errored.surfaced_errors.some((value) => value.includes('malformed claims')), true);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_STAGE7_UI_STATUS_PASS',
  run_kind: status.active_run_kind,
  gpu_owner: status.gpu_owner,
  next_rem_cycle: status.rem_coordination.next_rem.cycle_number
}, null, 2));
