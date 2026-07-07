'use strict';

// Enabled nighttime RSI contract: epoch -> REM -> resume -> morning candidate.
//
// Runs the REAL nightly coordinator, REAL nightly-training-session functions
// (segment launch, refresh, checkpoint accounting, finalization gate) and the
// REAL GPU-ownership ledger against isolated state with a virtual night
// clock. Only the container engine is a recording fake and epoch artifacts
// are laid down as real files, so the production state machine itself is what
// is being proven:
// - epoch 1 launches only in resource mode with the GPU owned by hf_training;
// - REM never overlaps training (dispatches only after the epoch container is
//   gone, while the GPU is owned by hf_rem_inference);
// - training resumes (segment 2) only after the REM claim completes;
// - a session with more completed epochs than REM cycles refuses to launch;
// - the simulated 07:00 boundary compiles exactly ONE pending candidate from
//   real epoch evidence, and reconciliation never duplicates it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNightlyTrainingCoordinator,
  readRemClaims
} = require('../src/self-improvement/training/training-scheduler.cjs');
const {
  readNightlySession,
  sessionPaths,
  startNightlyTrainingSegment,
  writeSession
} = require('../src/self-improvement/training/nightly-training-session.cjs');
const gpuOwnership = require('../src/self-improvement/training/gpu-ownership.cjs');
const {
  getSleepWindowForDate
} = require('../src/chat/sleep-cycle.cjs');
const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');

const FAKE_ENGINE = `#!/usr/bin/env bash
set -eu
STATE="\${FAKE_ENGINE_STATE:?}"
cmd="\${1:-}"
last="\${@: -1}"
case "$cmd" in
  --version) echo "podman version 6.0.0" ;;
  inspect)
    if [ "\${2:-}" = "--format" ]; then
      name="$last"
      if [ -f "$STATE/running-$name" ]; then
        case "\${3:-}" in
          *json*) echo 'true|"2026-07-06T23:01:00.000000000Z"' ;;
          *) echo "true" ;;
        esac
      else
        echo "Error: no such object: \\"$name\\"" >&2
        exit 125
      fi
    else
      name="$last"
      if [ -f "$STATE/running-$name" ]; then
        echo '[{"State":{"Running":true,"StartedAt":"2026-07-06T23:01:00.000000000Z"}}]'
      else
        echo "Error: no such object: \\"$name\\"" >&2
        exit 125
      fi
    fi ;;
  run)
    name=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--name" ]; then name="$arg"; fi
      prev="$arg"
    done
    touch "$STATE/running-$name"
    printf '%s\\n' "$name" >> "$STATE/run-log"
    ;;
  stop|rm)
    rm -f "$STATE/running-$last"
    ;;
  top) : ;;
  *) : ;;
esac
`;

function writeEpochArtifacts(session, config, epoch, step) {
  const adapterDir = session.runtime.adapter_output;
  const checkpointDir = path.join(
    adapterDir,
    config.training_checkpoint_dir_prefix + String(step)
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(checkpointDir, config.training_trainer_state_file_name),
    JSON.stringify({ epoch, global_step: step }) + '\n'
  );
  fs.writeFileSync(
    path.join(adapterDir, config.training_metrics_file_name),
    JSON.stringify({ epoch, global_step: step }) + '\n'
  );
  fs.writeFileSync(path.join(adapterDir, 'adapter_config.json'), '{}\n');
  fs.writeFileSync(path.join(adapterDir, 'adapter_model.safetensors'), 'stub-weights\n');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-night-enabled-'));
  const engineState = path.join(root, 'engine-state');
  fs.mkdirSync(engineState, { recursive: true });
  const enginePath = path.join(root, 'fake-podman');
  fs.writeFileSync(enginePath, FAKE_ENGINE, { mode: 0o700 });
  process.env.FAKE_ENGINE_STATE = engineState;

  const production = loadSelfImprovementConfig();
  const config = Object.freeze({
    ...production,
    runtime_root: path.join(root, 'runtime'),
    training_runtime_root: path.join(root, 'training-runtime'),
    training_rem_claim_file: path.join(root, 'training-runtime', 'rem-claims.json'),
    nightly_hf_operation_lock_file: path.join(root, 'training-runtime', 'hf-op.lock'),
    gpu_ownership_lock_file: path.join(root, 'gpu-owner.lock'),
    adapter_root: path.join(root, 'adapters'),
    dataset_root: path.join(root, 'datasets'),
    candidate_root: path.join(root, 'candidates'),
    sandbox_engine: enginePath,
    training_gpu_process_query_command: 'true',
    run_now_ack_timeout_ms: 5000,
    run_now_ack_poll_ms: 20,
    nightly_training_checkpoint_timeout_ms: 1500,
    nightly_training_checkpoint_poll_ms: 25
  });
  fs.mkdirSync(config.runtime_root, { recursive: true });
  fs.mkdirSync(config.training_runtime_root, { recursive: true });

  const window = getSleepWindowForDate(new Date());
  let virtualNow = new Date(new Date(window.start_at).getTime() + 60000);
  const resourceLog = [];
  const remDispatches = [];

  const runId = 'nightly-contract-' + Date.now().toString(16);
  function makeSession() {
    const runtime = sessionPaths(runId, config);
    fs.mkdirSync(runtime.adapter_output, { recursive: true });
    return writeSession({
      marker: 'FLOKI_V2_NIGHTLY_TRAINING_SESSION',
      schema_version: 1,
      run_id: runId,
      sleep_date: window.sleep_date,
      sleep_window_start: window.start_at,
      sleep_window_end: window.end_at,
      status: 'prepared',
      active: true,
      finalized: false,
      resource_entered: false,
      training_failed: false,
      training_error: null,
      training_config_sha256: null,
      current_container: null,
      segment_number: 0,
      completed_epochs: 0,
      rem_cycles_completed: 0,
      last_completed_epoch: null,
      last_rem_cycle_completed: null,
      segment_started_at: null,
      last_checkpoint_at: null,
      latest_checkpoint: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      runtime,
      hf_master: { path: path.join(root, 'hf-master'), identity: 'hf-master' },
      dataset: {
        dataset_id: 'dataset-contract',
        root: path.join(root, 'dataset-contract'),
        records_sha256: 'contract',
        record_count: 8
      },
      image: { image: config.training_container_image, rebuilt: false },
      base_training_config: null,
      candidate_id: null,
      adapter_id: null,
      restoration: null
    }, config);
  }
  fs.mkdirSync(path.join(root, 'hf-master'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dataset-contract'), { recursive: true });

  const coordinator = createNightlyTrainingCoordinator({
    config,
    now_provider: () => virtualNow,
    enter_resource: async (id) => {
      resourceLog.push({ action: 'enter', run_id: id });
      return { ok: true };
    },
    exit_resource: async (reason) => {
      resourceLog.push({ action: 'exit', reason });
      return { ok: true };
    },
    read_manual_nap: () => ({ active: false }),
    read_sleep_state: () => null,
    create_session: () => makeSession(),
    load_config: () => config,
    run_dream_engine: async (options) => {
      const sessionAtDispatch = readNightlySession(config);
      remDispatches.push({
        rem_cycle_number: options.rem_cycle_number,
        container_at_dispatch: sessionAtDispatch && sessionAtDispatch.current_container,
        gpu_owner_at_dispatch: gpuOwnership.currentOwner(config),
        dream_engine_allowed: Boolean(
          options.env && options.env.FLOKI_ALLOW_DREAM_ENGINE === '1'
        )
      });
      const file = path.join(root, 'dreams', 'rem-' + String(options.rem_cycle_number) + '.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'nightly REM dream after a completed epoch\n');
      return Object.freeze({ ok: true, dream_txt_file: file, dream_metadata_file: null });
    }
  });

  // --- Epoch 1 starts within the night window ---
  const started = await coordinator.reconcile({ now: virtualNow, rsi_paused: false });
  assert.equal(started.training_action, 'nightly_training_epoch_started');
  let session = readNightlySession(config);
  assert.ok(session.current_container && session.current_container.endsWith('-s1'),
    'segment 1 container must be launched');
  assert.equal(gpuOwnership.currentOwner(config), 'hf_training');
  assert.equal(coordinator.remMode({ now: virtualNow, rsi_paused: false }), 'epoch_triggered');
  assert.equal(coordinator.remMode({ now: virtualNow, rsi_paused: true }), 'wall_clock',
    'the pause sentinel hands REM back to the wall clock');
  assert.equal(remDispatches.length, 0, 'REM must not run while the epoch is in flight');

  // --- Epoch 1 completes (real checkpoint artifacts, container exits) ---
  const container1 = session.current_container;
  fs.rmSync(path.join(engineState, 'running-' + container1), { force: true });
  writeEpochArtifacts(session, config, 1, 4);
  virtualNow = new Date(virtualNow.getTime() + 30 * 60000);

  const afterEpoch = await coordinator.reconcile({ now: virtualNow, rsi_paused: false });
  assert.equal(afterEpoch.action, 'nightly_rem_after_completed_epoch',
    'a completed epoch must trigger exactly one REM cycle');
  session = readNightlySession(config);
  assert.equal(session.completed_epochs, 1);
  assert.equal(session.rem_cycles_completed, 1);
  assert.equal(remDispatches.length, 1);
  assert.equal(remDispatches[0].container_at_dispatch, null,
    'REM must never run while a training container exists (no overlap)');
  assert.equal(remDispatches[0].gpu_owner_at_dispatch, 'hf_rem_inference',
    'REM must own the GPU exclusively during dream cognition');
  assert.equal(remDispatches[0].dream_engine_allowed, true,
    'the epoch-triggered REM dispatch must carry the dream-engine allowance ' +
    '(FLOKI_ALLOW_DREAM_ENGINE=1); without it the first nightly REM in ' +
    'production dies with FLOKI_V2_DREAM_ENGINE_BLOCKED');
  assert.ok(session.current_container && session.current_container.endsWith('-s2'),
    'training must resume with segment 2 after REM completes');
  assert.equal(gpuOwnership.currentOwner(config), 'hf_training',
    'the GPU returns to training after REM');
  const claims = readRemClaims(config);
  assert.equal(Object.values(claims.claims).filter((c) => c.status === 'complete').length, 1);

  // --- A new epoch may not start before its REM completes ---
  const gated = await startNightlyTrainingSegment(writeSession({
    ...readNightlySession(config),
    current_container: null,
    resource_entered: true,
    completed_epochs: 2,
    rem_cycles_completed: 1
  }, config), { config });
  assert.equal(gated.status, 'waiting_for_rem_before_next_epoch',
    'epoch N+1 must wait for REM N');
  const runLog = fs.readFileSync(path.join(engineState, 'run-log'), 'utf8').trim().split('\n');
  assert.equal(runLog.length, 2, 'no container launch may happen while waiting for REM');
  writeSession({
    ...readNightlySession(config),
    current_container: session.current_container,
    completed_epochs: 1,
    rem_cycles_completed: 1
  }, config);

  // --- Simulated 07:00: discard partial epoch 2, compile exactly one candidate ---
  virtualNow = new Date(new Date(window.end_at).getTime() + 60000);
  const morning = await coordinator.reconcile({ now: virtualNow, rsi_paused: false });
  assert.equal(morning.action, 'wake_restoration');
  session = readNightlySession(config);
  assert.equal(session.finalized, true);
  assert.equal(session.status, 'candidate_ready_for_review');
  assert.ok(session.candidate_id, 'the morning boundary compiles a pending candidate');
  assert.ok(session.adapter_id);
  assert.equal(session.completed_epochs, 1,
    'the partial epoch 2 must be discarded, not counted');
  assert.ok(resourceLog.some((row) => row.action === 'exit'),
    'wake restoration must hand resources back');

  const candidateFiles = fs.existsSync(config.candidate_root)
    ? fs.readdirSync(config.candidate_root)
    : [];
  assert.equal(candidateFiles.length >= 1, true, 'candidate artifact must exist');

  // --- Reconciliation after the boundary never duplicates the candidate ---
  const again = await coordinator.reconcile({ now: virtualNow, rsi_paused: false });
  assert.equal(again.action, 'wake_restoration');
  const virtualNight = new Date(new Date(window.end_at).getTime() - 60 * 60000);
  const reopened = await coordinator.reconcile({ now: virtualNight, rsi_paused: false });
  assert.equal(reopened.action, 'nightly_training_already_finalized',
    'a finalized night must not reopen for the same sleep date');
  const sessionAfter = readNightlySession(config);
  assert.equal(sessionAfter.candidate_id, session.candidate_id,
    'reconciliation must not mint a second candidate');
  const candidatesAfter = fs.readdirSync(config.candidate_root);
  assert.deepEqual(candidatesAfter.sort(), candidateFiles.sort(),
    'candidate set must be identical after reconciliation');
  const remRerun = await coordinator.runNightlyRem({ now: virtualNight });
  assert.equal(remRerun.skipped, true,
    'REM re-dispatch after finalization must be a deduplicated no-op');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_NIGHTTIME_ENABLED_EPOCH_REM_LOOP_CONTRACT_PASS',
    candidate_id: session.candidate_id,
    rem_dispatches: remDispatches.length,
    resource_log: resourceLog
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
