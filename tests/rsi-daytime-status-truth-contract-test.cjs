'use strict';

const assert = require('node:assert/strict');
const {
  buildSelfImprovementUiStatus
} = require('../src/self-improvement/ui-status.cjs');
const {
  createNightlyTrainingCoordinator
} = require('../src/self-improvement/training/training-scheduler.cjs');

const config = {
  default_rsi_run_kind: 'code',
  default_objective: 'Select exactly one bounded, measurable improvement.',
  training_expected_gpu_name: 'NVIDIA GeForce RTX 3060',
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

function uiDependencies(overrides = {}) {
  return {
    readNightlySession: () => null,
    currentOwner: () => null,
    readRemClaims: () => ({ claims: {} }),
    listAdapters: () => [],
    loadSleepCycleState: () => null,
    readManualNapState: () => ({ active: false }),
    ...overrides
  };
}

// --- Scenario A: daytime idle must not report a stale/active run -----------

const idle = buildSelfImprovementUiStatus({
  config,
  dependencies: uiDependencies({
    readStatus: () => ({
      worker_running: true,
      paused: false,
      model_proxy_ready: true,
      state: 'waiting_for_idle',
      phase: 'nightly_wake_restored',
      current_run_id: null,
      current_container: null,
      current_role: 'unknown-stale',
      current_tool: 'stale-tool',
      objective_source: 'floki',
      last_transition: 'nightly_wake_restored',
      last_transition_at: '2026-06-28T11:00:05.000Z'
    })
  })
});

assert.equal(idle.active_run, false);
assert.equal(idle.active_run_kind, null,
  'idle status must not report the default run kind as ACTIVE');
assert.equal(idle.next_run_kind, 'code');
assert.equal(idle.current_phase, 'daytime_idle',
  'stale nightly_wake_restored phase must settle to daytime_idle');
assert.deepEqual({ ...idle.last_transition }, {
  phase: 'nightly_wake_restored',
  at: '2026-06-28T11:00:05.000Z'
}, 'wake restoration may only appear as historical last_transition');
assert.equal(idle.active_cycle_type, null,
  'must not report Floki-selected cycle while idle');
assert.equal(idle.active_goal, null);
assert.equal(idle.next_goal, config.default_objective);
assert.equal(idle.active_role, null);
assert.equal(idle.active_tool, null);
assert.equal(idle.gpu_device, 'NVIDIA GeForce RTX 3060');
assert.equal(idle.gpu_workload_owner, 'daytime_shared_cognition',
  'shared daytime GPU allocation must be described honestly');
assert.deepEqual(
  idle.gpu_workloads.map((row) => ({ ...row })),
  [
    { workload: 'live_cognition', provider: 'ollama' },
    { workload: 'live_vision', provider: 'vision' }
  ]
);
assert.equal(idle.exclusive_ownership_lock, null,
  'must not fabricate an exclusive lock during shared daytime use');
assert.equal(idle.gpu_owner, null, 'legacy gpu_owner field unchanged');

// --- Scenario B: active nightly training keeps exclusive-ownership truth ---

const training = buildSelfImprovementUiStatus({
  config,
  dependencies: uiDependencies({
    readStatus: () => ({
      worker_running: true,
      paused: false,
      state: 'training',
      current_run_id: 'nightly-training-1',
      current_run_kind: 'training',
      current_container: 'training-container',
      phase: 'nightly_training_segment_running',
      current_objective: 'nightly training',
      current_role: 'trainer',
      training_resource_mode: 'active'
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
    currentOwner: () => 'hf_training'
  })
});

assert.equal(training.active_run, true);
assert.equal(training.active_run_kind, 'training');
assert.equal(training.current_phase, 'nightly_training_segment_running',
  'active phase must pass through untouched');
assert.equal(training.active_goal, 'nightly training');
assert.equal(training.active_role, 'trainer');
assert.equal(training.active_cycle_type, 'floki_selected');
assert.equal(training.gpu_device, 'NVIDIA GeForce RTX 3060',
  'the RTX 3060 is the device, never the owner');
assert.equal(training.gpu_workload_owner, 'hf_training');
assert.equal(training.exclusive_ownership_lock, 'hf_training');
assert.equal(training.gpu_owner, 'hf_training');
assert.equal(training.gpu_workloads.length, 1);
assert.equal(training.gpu_workloads[0].workload, 'qlora_training');

// --- Scenario C: reconcile wake restoration settles once, then idempotent --

(async () => {
  const statusWrites = [];
  let persistedPhase = 'nightly_wake_restored';
  let session = {
    run_id: 'wake-truth-test',
    sleep_date: '2026-06-27',
    active: true,
    finalized: false,
    resource_entered: true,
    current_container: 'training-container'
  };

  const coordinator = createNightlyTrainingCoordinator({
    config: {
      training_enabled: true,
      nightly_training_enabled: true,
      nightly_rem_provider: 'huggingface'
    },
    gpu: {
      currentOwner: () => 'hf_training',
      readOwner: () => ({ owner: 'hf_training' }),
      release: () => {},
      transfer: () => {},
      acquire: () => {}
    },
    read_session: () => session,
    checkpoint_session: async (value) => {
      session = { ...value, current_container: null };
      return { ok: true, session };
    },
    finalize_session: (value) => {
      session = { ...value, active: false, finalized: true };
      return session;
    },
    exit_resource: async () => ({
      ok: true,
      result: { lifecycle_restored: true }
    }),
    set_resource_entered: (value, entered) => {
      session = { ...value, resource_entered: entered };
      return session;
    },
    write_session: (value) => {
      session = value;
      return value;
    },
    get_sleep_window: () => ({
      sleep_date: '2026-06-27',
      start_at: '2026-06-28T03:00:00.000Z',
      end_at: '2026-06-28T11:00:00.000Z'
    }),
    is_within_sleep_window: () => false,
    read_manual_nap: () => null,
    read_status: () => ({ phase: persistedPhase }),
    audit: () => {},
    status: (patch) => {
      statusWrites.push(patch);
      if (patch && patch.phase) persistedPhase = patch.phase;
    }
  });

  // Pass 1: real restoration work (container + held resource) → single
  // settling write recording the transition.
  const first = await coordinator.reconcile({
    now: new Date('2026-06-28T11:00:01.000Z')
  });
  assert.equal(first.action, 'wake_restoration');
  assert.equal(statusWrites.length, 1,
    'restoration pass must write status exactly once');
  assert.equal(statusWrites[0].phase, 'daytime_idle');
  assert.equal(statusWrites[0].last_transition, 'nightly_wake_restored');
  assert.equal(typeof statusWrites[0].last_transition_at, 'string');
  assert.equal(statusWrites[0].current_run_id, null);
  assert.equal(statusWrites[0].current_container, null);
  assert.equal(statusWrites[0].training_resource_mode, 'idle');
  assert.equal(statusWrites[0].gpu_owner, null);
  assert.equal(statusWrites[0].wake_restoration_error, null);
  assert.equal(session.finalized, true);
  assert.equal(session.resource_entered, false);

  // Pass 2: nothing left to restore and phase already settled → NO write.
  const second = await coordinator.reconcile({
    now: new Date('2026-06-28T12:00:00.000Z')
  });
  assert.equal(second.action, 'wake_restoration');
  assert.equal(statusWrites.length, 1,
    'repeated daytime tick must not rewrite status');

  // Pass 3: persisted phase is an active daytime code-run phase → the
  // reconcile tick must not clobber it.
  persistedPhase = 'experimenting';
  await coordinator.reconcile({
    now: new Date('2026-06-28T13:00:00.000Z')
  });
  assert.equal(statusWrites.length, 1,
    'wake reconcile must never clobber an active daytime run phase');
  assert.equal(persistedPhase, 'experimenting');

  // Pass 4: a stale persisted 'nightly_wake_restored' with no work left is
  // corrected once to daytime_idle.
  persistedPhase = 'nightly_wake_restored';
  await coordinator.reconcile({
    now: new Date('2026-06-28T14:00:00.000Z')
  });
  assert.equal(statusWrites.length, 2,
    'stale nightly_wake_restored phase gets one corrective settle write');
  assert.deepEqual(statusWrites[1], { phase: 'daytime_idle' });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_DAYTIME_STATUS_TRUTH_PASS',
    idle_active_run: idle.active_run,
    idle_phase: idle.current_phase,
    idle_gpu_workload_owner: idle.gpu_workload_owner,
    training_run_kind: training.active_run_kind,
    training_lock: training.exclusive_ownership_lock,
    scheduler_settle_writes: statusWrites.length
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
