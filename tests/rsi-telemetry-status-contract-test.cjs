'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  loadSelfImprovementConfig
} = require(path.join(ROOT, 'src/self-improvement/config.cjs'));
const {
  buildSelfImprovementUiStatus
} = require(path.join(ROOT, 'src/self-improvement/ui-status.cjs'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-telemetry-'));
try {
  const logFile = path.join(tmp, 'sandbox.log');
  const now = new Date();
  fs.writeFileSync(logFile, [
    JSON.stringify({
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT',
      created_at: now.toISOString(),
      type: 'progress_heartbeat',
      detail: {
        run_id: 'run-telemetry',
        event: 'model_turn_start',
        phase: 'discovery',
        current_role: 'discovery',
        current_tool: 'model_turn',
        resource_mode: 'cognition/model inference',
        gpu_owner: 'self-improvement/cognition'
      }
    })
  ].join('\n') + '\n');

  const config = loadSelfImprovementConfig();
  const status = buildSelfImprovementUiStatus({
    config,
    now,
    dependencies: {
      readStatus: () => ({
        enabled: true,
        state: 'experimenting',
        phase: 'sandbox_agent_running',
        current_run_id: 'run-telemetry',
        current_run_kind: 'code',
        current_objective: 'trace telemetry',
        current_container: 'floki-rsi-sandbox',
        last_sandbox_log_file: logFile,
        worker_running: true,
        model_proxy_ready: true
      }),
      currentOwner: () => null,
      readNightlySession: () => null,
      readRemClaims: () => ({ claims: {} }),
      listAdapters: () => [],
      loadSleepCycleState: () => null,
      readManualNapState: () => null,
      evaluateNightlyPolicy: () => ({
        active: false,
        chat_available: true,
        code_sandbox_allowed: true,
        manual_training_allowed: true,
        run_now_allowed: true,
        run_now_block_reason: null
      })
    }
  });

  assert.equal(status.active_role, 'discovery');
  assert.equal(status.active_tool, 'model_turn');
  assert.equal(status.resource_mode, 'cognition/model inference');
  assert.equal(status.gpu_owner, 'self-improvement/cognition');
  assert.equal(status.gpu_workload_owner, 'self-improvement/cognition');
  assert.equal(status.telemetry_stale, false);

  const idle = buildSelfImprovementUiStatus({
    config,
    now,
    dependencies: {
      readStatus: () => ({
        enabled: true,
        state: 'waiting_for_idle',
        phase: 'completed',
        current_run_id: null,
        worker_running: true,
        model_proxy_ready: true,
        last_sandbox_log_file: logFile
      }),
      currentOwner: () => null,
      readNightlySession: () => null,
      readRemClaims: () => ({ claims: {} }),
      listAdapters: () => [],
      loadSleepCycleState: () => null,
      readManualNapState: () => null,
      evaluateNightlyPolicy: () => ({
        active: false,
        chat_available: true,
        code_sandbox_allowed: true,
        manual_training_allowed: true,
        run_now_allowed: true,
        run_now_block_reason: null
      })
    }
  });
  assert.equal(idle.active_role, null);
  assert.equal(idle.active_tool, null);
  assert.equal(idle.resource_mode, 'idle');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_TELEMETRY_STATUS_CONTRACT_PASS',
    active_role: status.active_role,
    active_tool: status.active_tool,
    resource_mode: status.resource_mode,
    gpu_owner: status.gpu_owner
  }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
