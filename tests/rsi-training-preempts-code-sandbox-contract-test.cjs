'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const {
  preemptCodeCycleForTraining
} = require(
  '../src/self-improvement/promotion.cjs'
);

async function main() {
  assert.match(process.version, /^v(?:2[4-9]|[3-9]\d|[1-9]\d{2,})\./);

  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      'floki-training-preempts-code-'
    )
  );
  const runRequestFile = path.join(
    root,
    'run-request.json'
  );
  const pidFile = path.join(root, 'worker.pid');

  fs.writeFileSync(
    runRequestFile,
    JSON.stringify({
      request_id: 'code-request',
      kind: 'code'
    }) + '\n'
  );

  const active = {
    worker_running: true,
    model_proxy_ready: true,
    state: 'experimenting',
    phase: 'sandbox_agent_running',
    current_run_id: 'rsi-code-active',
    current_run_kind: 'code',
    current_candidate_type: 'code_patch',
    current_container: 'floki-rsi-code-active'
  };
  const cleared = {
    worker_running: true,
    model_proxy_ready: true,
    state: 'waiting_for_idle',
    phase: 'preempted',
    current_run_id: null,
    current_run_kind: null,
    current_container: null
  };

  const reads = [active, cleared];
  const updates = [];
  const audits = [];
  const stops = [];

  try {
    const result = await preemptCodeCycleForTraining(
      active,
      {
        default_rsi_run_kind: 'code',
        allowed_rsi_run_kinds: 'code|training',
        rsi_run_kind_candidate_types:
          'code=code_patch|training=model_adapter',
        code_patch_promoter_accepted_candidate_types:
          'code_patch',
        run_now_ack_timeout_ms: 5000,
        run_now_ack_poll_ms: 10
      },
      {
        layout: {
          runRequestFile,
          pidFile
        },
        read_status: () =>
          reads.length > 1
            ? reads.shift()
            : cleared,
        update_status: (patch) => {
          updates.push(patch);
          return patch;
        },
        append_audit: (type, detail) => {
          audits.push({ type, detail });
        },
        stop_active_run_process: (reason) => {
          stops.push(reason);
          return true;
        },
        signal_worker: () => 12345,
        wait: async () => {}
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.verified, true);
    assert.equal(
      result.marker,
      'FLOKI_V2_CODE_SANDBOX_PREEMPTED_FOR_TRAINING'
    );
    assert.equal(
      fs.existsSync(runRequestFile),
      false,
      'pending code request must be cancelled'
    );
    assert.ok(
      stops.includes(
        'maker_training_preempted_code_sandbox'
      ),
      'active code container must receive a stop request'
    );
    assert.equal(
      audits.some(
        (row) =>
          row.type ===
          'code_sandbox_preempted_for_training'
      ),
      true
    );
    assert.equal(
      updates.some(
        (patch) =>
          patch.phase ===
          'training_preempting_code_sandbox'
      ),
      true
    );

    const promotionSource = fs.readFileSync(
      path.join(
        ROOT,
        'src/self-improvement/promotion.cjs'
      ),
      'utf8'
    );
    assert.match(
      promotionSource,
      /runKind === 'training'[\s\S]*activeCodeCycle/
    );
    assert.match(
      promotionSource,
      /await preemptCodeCycleForTraining/
    );
    assert.match(
      promotionSource,
      /async function abortActiveRun/
    );

    const apiSource = fs.readFileSync(
      path.join(
        ROOT,
        'src/self-improvement/api.cjs'
      ),
      'utf8'
    );
    assert.match(apiSource, /abortActiveRun/);

    const runtimeSource = fs.readFileSync(
      path.join(
        ROOT,
        'src/runtime/chat-local-runtime.cjs'
      ),
      'utf8'
    );
    assert.match(
      runtimeSource,
      /await selfImprovementApi\.abort/
    );

    const statusSource = fs.readFileSync(
      path.join(
        ROOT,
        'src/self-improvement/ui-status.cjs'
      ),
      'utf8'
    );
    assert.match(statusSource, /can_stop_code/);
    assert.match(
      statusSource,
      /can_run_training:[\s\S]*!trainingRunActive/
    );

    const panelSource = fs.readFileSync(
      path.join(
        ROOT,
        'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
      ),
      'utf8'
    );
    assert.match(panelSource, /Abort sandbox/);
    assert.match(panelSource, /Abort training/);
    assert.match(
      panelSource,
      /onClick=\{runTraining\} disabled=\{Boolean\(busy\) \|\| makerCycleQueued \|\| !canRunTraining\}/
    );

    console.log(JSON.stringify({
      ok: true,
      marker:
        'FLOKI_TRAINING_PREEMPTS_CODE_SANDBOX_CONTRACT_PASS',
      stop_sandbox_button: true,
      training_preempts_code_sandbox: true,
      pending_code_request_cancelled: true,
      worker_paused: false,
      second_cycle_rejected: false
    }, null, 2));
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
