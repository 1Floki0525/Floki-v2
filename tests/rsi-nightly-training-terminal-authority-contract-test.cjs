
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
assert.ok(
  Number(process.versions.node.split('.')[0]) >= 24,
  'Floki-v2 requires Node 24 or newer'
);


const PERSISTENT_PTY_CONTRACT_REGISTRY_MARKER =
  'FLOKI_RSI_PTY_PERSISTENT_TEST_REGISTRY_V1';
const PERSISTENT_PTY_CONTRACTS = Object.freeze([
  'tests/self-improvement-pty-session-contract-test.cjs',
  'tests/self-improvement-pty-integration-contract-test.cjs',
  'tests/self-improvement-run-now-permanent-workstation-contract-test.cjs',
  'tests/rsi-xterm-terminal-ui-contract-test.cjs'
]);

function runPersistentPtyContracts() {
  for (const relative of PERSISTENT_PTY_CONTRACTS) {
    const absolute = path.join(ROOT, relative);
    assert.equal(
      fs.existsSync(absolute),
      true,
      'registered PTY contract is missing from the repository: ' + relative
    );
    const result = spawnSync(process.execPath, [absolute], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLOKI_RSI_PTY_REGISTERED_SUITE: '1'
      },
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(
      result.status,
      0,
      relative + ' failed from the permanent PTY registry' +
        (result.error ? ': ' + result.error.message : '') +
        (result.signal ? ' signal=' + result.signal : '')
    );
  }
  return Object.freeze({
    marker: PERSISTENT_PTY_CONTRACT_REGISTRY_MARKER,
    tests: PERSISTENT_PTY_CONTRACTS
  });
}

const agent = read('containers/self-improvement/agent.cjs');
const convergenceSource = read('src/self-improvement/convergence-policy.cjs');
for (const token of [
  'runAutonomousSelectionTransaction',
  'format: selectionDecisionSchema',
  "protocol: 'ollama_json_schema'",
  "executeTool('select_experiment', args)"
]) assert.equal(agent.includes(token), true, 'canonical selection token missing: ' + token);
for (const token of [
  'runAutonomousSelectionRescue',
  'selectExperimentArgsFromMessage',
  "finishWithoutCandidate('iteration_limit')",
  'agent_iteration_limit_reached',
  'model_failed_to_select_experiment_after_forced_selection'
]) assert.equal(agent.includes(token), false, 'forbidden agent progression remains: ' + token);
assert.equal(/iteration\s*<\s*MAX_ITERATIONS/.test(agent), false);
for (const token of [
  "transition('selection_required'",
  'implementation_has_no_workspace_change',
  'model_failed_to_select_experiment_after_forced_selection'
]) assert.equal(convergenceSource.includes(token), false, 'forbidden convergence exit remains: ' + token);

const { createConvergencePolicy } = require('../src/self-improvement/convergence-policy.cjs');
const policy = createConvergencePolicy({
  discovery_tool_limit: 1,
  research_tool_limit: 1,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 1,
  implementation_start_deadline_iteration: 2,
  search_only_streak_limit: 1,
  failed_lookup_limit: 1,
  max_no_change_iterations: 1,
  focused_verification_failure_limit: 4,
  focused_repair_no_progress_iteration_limit: 8
}, () => {});
for (let iteration = 1; iteration <= 200; iteration += 1) {
  policy.beginIteration(iteration);
  assert.equal(policy.endIteration(), null, 'iteration count must not terminate evidence gathering');
}
assert.notEqual(policy.snapshot().phase, 'selection_required');
assert.equal(
  policy.authorize('select_experiment', {}).ok,
  false,
  'selection must remain blocked until evidence readiness is satisfied'
);
policy.record('get_task_state', {}, { ok: true });
policy.record('get_self_context', {}, { ok: true });
policy.record('search_source', { query: 'nightly training' }, { ok: true });
policy.record(
  'read_file',
  { path: 'src/self-improvement/training/training-scheduler.cjs' },
  { ok: true, path: 'src/self-improvement/training/training-scheduler.cjs' }
);
assert.equal(policy.snapshot().autonomous_selection_ready, true);
assert.equal(
  policy.authorize('select_experiment', {}).ok,
  true,
  'selection must become available from evidence readiness, not an iteration deadline'
);

const { dueNightlyRemNow } = require('../src/self-improvement/training/training-scheduler.cjs');
const baseSession = {
  active: true,
  finalized: false,
  aborted: false,
  current_container: null,
  latest_checkpoint: '/tmp/checkpoint',
  completed_epochs: 0,
  rem_cycles_completed: 0
};
assert.equal(dueNightlyRemNow(new Date(), baseSession), false, 'REM must not begin before a complete epoch');
assert.equal(dueNightlyRemNow(new Date(), { ...baseSession, completed_epochs: 1 }), true, 'one completed epoch must trigger one REM');
assert.equal(dueNightlyRemNow(new Date(), { ...baseSession, completed_epochs: 1, rem_cycles_completed: 1 }), false, 'next epoch must follow REM completion');
assert.equal(dueNightlyRemNow(new Date(), { ...baseSession, completed_epochs: 2, rem_cycles_completed: 1, current_container: 'running' }), false, 'REM cannot interrupt a running epoch');

const { buildRemCycles } = require('../src/chat/manual-nap.cjs');
const napStart = '2026-07-04T12:00:00.000Z';
const napWake = '2026-07-04T12:30:00.000Z';
const napCycles = buildRemCycles(napStart, napWake, 10, 10, [], { max_rem_cycles: 2 });
assert.deepEqual(
  napCycles.map((cycle) => cycle.scheduled_at),
  ['2026-07-04T12:10:00.000Z', '2026-07-04T12:20:00.000Z'],
  'manual nap must retain +10 and +20 REM timing'
);
assert.equal(new Date(napWake).getTime() - new Date(napStart).getTime(), 30 * 60000, 'manual nap wake remains +30 minutes');

const { deriveTrainingTruth, observeTrainingReality } = require('../src/self-improvement/training/training-observation.cjs');
const liveTraining = deriveTrainingTruth({
  session: { active: true, finalized: false },
  training_container: {
    exists: true,
    running: true,
    pid: 500,
    processes: [{ host_pid: 501, command: 'python', args: 'train_qlora.py' }]
  },
  rem_container: { exists: false, running: false, pid: 0, processes: [] },
  nvidia: { ok: true, rows: [{ pid: 501, process_name: 'python', used_memory_mb: 4096 }] },
  log: { exists: true, advancing: true },
  lock_owner: 'hf_training'
});
assert.equal(liveTraining.live_training, true);
assert.equal(liveTraining.observed_gpu_owner, 'hf_training');
assert.equal(liveTraining.active_hf_model, true);
const stale = deriveTrainingTruth({
  session: { active: true, finalized: false, completed_epochs: 0, rem_cycles_completed: 0 },
  training_container: { exists: false, running: false, pid: 0, processes: [] },
  rem_container: { exists: false, running: false, pid: 0, processes: [] },
  nvidia: { ok: true, rows: [] },
  log: { exists: false, advancing: false },
  lock_owner: 'hf_training'
});
assert.equal(stale.live_training, false);
assert.equal(stale.observed_gpu_owner, null);
assert.equal(stale.stale_gpu_owner, true);
assert.equal(stale.active_hf_model, false);
const reservedStarting = deriveTrainingTruth({
  session: {
    active: true,
    finalized: false,
    resource_entered: true,
    status: 'prepared',
    updated_at: new Date(1000000).toISOString()
  },
  training_container: { exists: false, running: false, pid: 0, processes: [] },
  rem_container: { exists: false, running: false, pid: 0, processes: [] },
  nvidia: { ok: true, rows: [] },
  log: { exists: false, advancing: false },
  lock_owner: 'hf_training',
  now_ms: 1001000,
  startup_grace_ms: 120000
});
assert.equal(reservedStarting.live_training, false, 'a reservation is not active training');
assert.equal(reservedStarting.observed_gpu_owner, null, 'a reservation is not observed GPU ownership');
assert.equal(reservedStarting.stale_gpu_owner, false, 'fresh startup reservation must not be reconciled out from under launch');
const observationFailure = deriveTrainingTruth({
  session: { active: true, finalized: false, resource_entered: true },
  training_container: { exists: false, running: false, pid: 0, processes: [], error: 'podman unavailable' },
  rem_container: { exists: false, running: false, pid: 0, processes: [] },
  nvidia: { ok: false, rows: [], error: 'nvidia query failed' },
  log: { exists: false, advancing: false },
  lock_owner: 'hf_training'
});
assert.equal(observationFailure.stale_gpu_owner, false, 'observation failure must not be mistaken for stale ownership');
assert.equal(observationFailure.phase, 'observation_failed');
assert.match(observationFailure.observation_error, /podman unavailable/);

const partialConfigObservation = observeTrainingReality({
  config: {
    training_enabled: true,
    nightly_training_enabled: true
  },
  session: {
    active: true,
    finalized: false,
    resource_entered: true,
    status: 'prepared',
    current_container: null,
    updated_at: new Date(2000000).toISOString()
  },
  training_container: {
    exists: false,
    running: false,
    pid: 0,
    processes: []
  },
  rem_container: {
    exists: false,
    running: false,
    pid: 0,
    processes: []
  },
  nvidia: { ok: true, rows: [] },
  log: { exists: false, advancing: false },
  lock_owner: 'hf_training',
  reconcile_stale_owner: true,
  release_owner: () => {
    throw new Error('fresh startup reservation must not be released');
  },
  now_ms: 2001000
});
assert.equal(partialConfigObservation.stale_gpu_owner, false);
assert.equal(partialConfigObservation.reconciliation_error, null);
assert.equal(partialConfigObservation.phase, 'prepared');

const { readRawTerminal, selectRawTerminalSource } = require('../src/runtime/raw-terminal-log.cjs');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-raw-terminal-'));
  try {
    const file = path.join(temp, 'training.log');
    const content = Array.from({ length: 4096 }, (_, index) => `raw-line-${index}\n`).join('');
    fs.writeFileSync(file, content);
    const stat = fs.statSync(file);
    const source = {
      source_id: 'test-source',
      kind: 'nightly_training',
      run_id: 'night-test',
      file,
      stat,
      active: true
    };
    const first = await readRawTerminal({ source, cursor: 0, max_bytes: 4096 });
    assert.equal(first.text.length <= 4096, true, 'terminal read must remain bounded');
    assert.equal(first.next_cursor <= 4096, true);
    assert.equal(first.has_newer, true);
    const later = await readRawTerminal({ source, cursor: first.next_cursor, max_bytes: 4096 });
    assert.equal(later.cursor, first.next_cursor);
    const older = await readRawTerminal({ source, before_cursor: later.next_cursor, max_bytes: 4096 });
    assert.equal(older.next_cursor, later.next_cursor);
    assert.equal(older.cursor < older.next_cursor, true, 'older output must be loaded from disk');

    const trainingRoot = path.join(temp, 'training-root');
    const workspaceRoot = path.join(temp, 'workspace-root');
    const runtimeRoot = path.join(temp, 'runtime-root');
    fs.mkdirSync(path.join(trainingRoot, 'night-run'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'code-run'), { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const trainingLog = path.join(trainingRoot, 'night-run', 'training.log');
    const codeLog = path.join(workspaceRoot, 'code-run', 'sandbox.log');
    fs.writeFileSync(trainingLog, 'raw HF training output\n');
    fs.writeFileSync(codeLog, 'raw code sandbox output\n');
    const terminalConfig = {
      training_runtime_root: trainingRoot,
      workspace_root: workspaceRoot,
      runtime_root: runtimeRoot,
      training_log_file_name: 'training.log'
    };
    const selectedTraining = selectRawTerminalSource({
      config: terminalConfig,
      status: { current_run_kind: 'code', current_run_id: 'code-run', last_sandbox_log_file: codeLog },
      session: { active: true, finalized: false, run_id: 'night-run', runtime: { log_file: trainingLog } }
    });
    assert.equal(selectedTraining.kind, 'nightly_training', 'active nightly training log must outrank code history');
    const selectedCode = selectRawTerminalSource({
      config: terminalConfig,
      status: { current_run_kind: 'code', current_run_id: 'code-run', last_sandbox_log_file: codeLog },
      session: null
    });
    assert.equal(selectedCode.kind, 'code', 'active code sandbox log must be available to the raw terminal');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const { buildRemSchedule } = require('../src/chat/sleep-cycle.cjs');
  const window = {
    start_at: '2026-07-04T03:00:00.000Z',
    end_at: '2026-07-04T11:00:00.000Z'
  };
  assert.deepEqual(buildRemSchedule(window, { nightly_epoch_triggered_rem: true }), []);
  const { abortNightlyTrainingSession } = require('../src/self-improvement/training/nightly-training-session.cjs');
  const abortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-abort-training-'));
  try {
    const abortConfig = {
      project_root: abortRoot,
      sandbox_engine: 'podman',
      podman_command_timeout_ms: 1000,
      podman_output_buffer_bytes: 1024 * 1024,
      training_runtime_root: path.join(abortRoot, 'training'),
      nightly_training_session_file_name: 'nightly-session.json',
      runtime_root: path.join(abortRoot, 'runtime'),
      workspace_root: path.join(abortRoot, 'workspaces'),
      candidate_root: path.join(abortRoot, 'candidates'),
      outbox_root: path.join(abortRoot, 'outbox'),
      status_file_name: 'status.json',
      worker_pid_file_name: 'worker.pid',
      pause_file_name: 'pause',
      run_request_file_name: 'run-request.json',
      current_container_file_name: 'current-container.json',
      audit_file_name: 'audit.jsonl',
      approval_token_file_name: 'approval-token',
      promotion_lock_file_name: 'promotion.lock',
      atomic_temp_random_bytes: 4,
      enabled: true,
      default_rsi_run_kind: 'code',
      ui_poll_ms: 1000
    };
    const controlDir = path.join(abortRoot, 'control');
    fs.mkdirSync(controlDir, { recursive: true });
    const abortSession = {
      marker: 'FLOKI_V2_NIGHTLY_TRAINING_SESSION',
      run_id: 'night-abort-test',
      sleep_date: '2026-07-04',
      active: true,
      finalized: false,
      aborted: false,
      status: 'training',
      current_container: 'floki-training-test',
      completed_epochs: 1,
      rem_cycles_completed: 1,
      runtime: {
        control_file: path.join(controlDir, 'control.json'),
        control_response_file: path.join(controlDir, 'response.json')
      }
    };
    let fakeRunning = true;
    let removeCalls = 0;
    const fakeSpawnSync = (_command, args) => {
      if (args[0] === 'top') {
        return fakeRunning
          ? { status: 0, stdout: 'HPID\n424242\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'no such container' };
      }
      if (args[0] === 'rm' && args[1] === '-f') {
        removeCalls += 1;
        fakeRunning = false;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'inspect') {
        return fakeRunning
          ? { status: 0, stdout: 'true\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'no such container' };
      }
      throw new Error('unexpected fake container command: ' + args.join(' '));
    };
    const aborted = abortNightlyTrainingSession(abortSession, {
      config: abortConfig,
      reason: 'focused_contract_abort',
      spawnSync: fakeSpawnSync,
      process_is_alive: () => fakeRunning
    });
    assert.equal(removeCalls, 1, 'abort must force-remove the real training container path');
    assert.equal(aborted.verified, true, 'abort must verify the workload is gone');
    assert.equal(aborted.verified_container_gone, true);
    assert.equal(aborted.verified_processes_gone, true);
    assert.equal(aborted.session.status, 'aborted');
    assert.equal(aborted.session.finalized, true);
    assert.equal(aborted.session.candidate_id, null, 'aborted session must never create a candidate');
  } finally {
    fs.rmSync(abortRoot, { recursive: true, force: true });
  }

  const sessionSource = read('src/self-improvement/training/nightly-training-session.cjs');
  assert.match(sessionSource, /const requiredRemCycles = completedEpochs;/);
  assert.match(sessionSource, /discard_partial_epoch/);
  assert.match(sessionSource, /abortNightlyTrainingSession/);
  assert.match(sessionSource, /candidate_id: null/);
  const schedulerSource = read('src/self-improvement/training/training-scheduler.cjs');
  assert.match(schedulerSource, /nightly_rem_after_completed_epoch/);
  assert.match(schedulerSource, /start_next_complete_epoch/);
  assert.match(schedulerSource, /observeTrainingReality/);
  const resourceSource = read('src/self-improvement/training/runtime-resource-controller.cjs');
  assert.match(resourceSource, /scheduler_preserved = true/);
  assert.doesNotMatch(resourceSource, /runConfiguredScript\(\s*config,\s*'training_sleep_scheduler_stop_script'/);

  const runtime = read('src/runtime/chat-local-runtime.cjs');
  assert.match(runtime, /readRawTerminal/);
  assert.match(runtime, /FLOKI_V2_RSI_SYSTEM_START_VERIFIED/);
  assert.match(runtime, /FLOKI_V2_RSI_SYSTEM_STOP_VERIFIED/);
  assert.match(runtime, /FLOKI_V2_RSI_SYSTEM_RESTART_VERIFIED/);
  assert.match(runtime, /FLOKI_V2_TRAINING_ABORT_RESTORE_FAILED/);
  const terminalSource = read('src/runtime/raw-terminal-log.cjs');
  assert.match(terminalSource, /readBoundedBytes/);
  assert.match(terminalSource, /before_cursor/);
  assert.match(terminalSource, /nightly_training/);
  assert.match(terminalSource, /scheduler_fallback/);
  assert.doesNotMatch(terminalSource, /readFileSync\(source\.file/);

  const registry = require('../src/control-plane/module-registry.cjs');
  const expectedActions = ['start', 'stop', 'reset'];
  assert.equal(registry.MODULE_KEYS.length, 14);
  for (const key of registry.MODULE_KEYS) {
    assert.deepEqual(
      registry.moduleActions(key),
      expectedActions,
      key + ' must expose real start, stop, and reset controls'
    );
    const module = registry.getModuleConfig(key);
    assert.ok(module.start, key + ' start operation missing');
    assert.ok(module.stop, key + ' stop operation missing');
    assert.ok(module.reset, key + ' reset operation missing');
  }
  assert.deepEqual(registry.moduleActions('unknown_service'), []);
  const { createChatLocalInterfaceApi } = require('../src/runtime/chat-local-interface-api.cjs');
  const cards = createChatLocalInterfaceApi({ runtime_dir: undefined }).buildServices();
  assert.equal(cards.length, registry.MODULE_KEYS.length, 'system card count mismatch');
  assert.deepEqual(
    cards.map((card) => card.key).sort(),
    [...registry.MODULE_KEYS].sort(),
    'system card keys must match the authoritative registry'
  );
  for (const card of cards) {
    assert.equal(card.startAvailable, true, card.key + ' Start control must be visible and routed');
    assert.equal(card.stopAvailable, true, card.key + ' Stop control must be visible and routed');
    assert.equal(card.resetAvailable, true, card.key + ' Reset control must be visible and routed');
    assert.equal(card.restartAvailable, true, card.key + ' Restart control must be visible and routed');
  }
  assert.match(runtime, /SUPERVISED_MODULES\.has\(moduleKey\)/);
  assert.match(runtime, /cognitionLifecycleResult\(action\)/);
  assert.match(runtime, /hearingLifecycleResult\(action\)/);
  assert.match(runtime, /speechLifecycleResult\(action\)/);
  assert.match(runtime, /memoryLifecycleResult\(action\)/);
  assert.match(runtime, /emotionLifecycleResult\(action\)/);
  assert.match(runtime, /liveEventStreamLifecycleResult\(action\)/);
  assert.match(runtime, /dreamEngineLifecycleResult\(action\)/);
  assert.match(runtime, /clientAppLifecycleResult\(moduleKey, action, body\)/);
  assert.match(runtime, /rsiLifecycleResult\(action\)/);

  const rsiUi = read('apps/floki-neural-interface/src/pages/RSILab.jsx');
  assert.match(rsiUi, /RSI Terminal/);
  assert.match(rsiUi, /Load older output/);
  assert.match(rsiUi, /Abort Training/);
  assert.match(rsiUi, /before_cursor/);
  assert.doesNotMatch(rsiUi, /getSelfImprovementActivity/);
  assert.doesNotMatch(rsiUi, /setEvents\(\[\]\)/);
  const dreamsUi = read('apps/floki-neural-interface/src/pages/DreamsDashboard.jsx');
  assert.match(dreamsUi, /One complete HF training epoch, then one REM dream, repeating until 07:00 America\/Toronto/);
  assert.match(dreamsUi, /One candidate per night/);
  assert.doesNotMatch(dreamsUi, /One REM dream every/);

  const ptyRegistry = runPersistentPtyContracts();
  assert.equal(
    ptyRegistry.marker,
    'FLOKI_RSI_PTY_PERSISTENT_TEST_REGISTRY_V1'
  );
  console.log('FLOKI_RSI_NIGHTLY_TRAINING_TERMINAL_AUTHORITY_CONTRACT_PASS');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
