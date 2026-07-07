'use strict';

// Contract: exactly one sandbox is active at a time, multiple pending candidates
// are supported, and a pending-review candidate does NOT block the next cycle
// (only a full queue does). Exercises the real worker/store functions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/self-improvement/store.cjs');
const worker = require('../src/self-improvement/worker.cjs');
const promotion = require('../src/self-improvement/promotion.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-one-'));
const config = Object.assign({}, base, {
  runtime_root: path.join(tmp, 'runtime'),
  candidate_root: path.join(tmp, 'candidates'),
  outbox_root: path.join(tmp, 'outbox'),
  workspace_root: path.join(tmp, 'workspaces'),
  model_proxy_root: path.join(tmp, 'model-proxy'),
  max_pending_review_candidates: 3
});

function writeCandidate(id, status) {
  const dir = path.join(config.candidate_root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    status,
    created_at: new Date().toISOString(),
    candidate_type: 'code_patch'
  }));
}

async function main() {
  store.ensureLayout(config);

  // --- multiple pending candidates supported; pending does not block until full ---
  assert.equal(worker.pendingReviewCount(config), 0);
  assert.equal(worker.pendingReviewQueueFull(config), false);

  writeCandidate('cand-1', 'pending_review');
  assert.equal(worker.pendingReviewCount(config), 1);
  assert.equal(worker.pendingReviewQueueFull(config), false, 'one pending candidate does NOT block the next cycle');

  writeCandidate('cand-2', 'pending_review');
  assert.equal(worker.pendingReviewCount(config), 2);
  assert.equal(worker.pendingReviewQueueFull(config), false, 'multiple pending candidates still allowed');

  writeCandidate('cand-3', 'pending_review');
  assert.equal(worker.pendingReviewCount(config), 3);
  assert.equal(worker.pendingReviewQueueFull(config), true, 'queue full only at the YAML cap');

  // denied/approved candidates move to history and do not count against the queue
  writeCandidate('cand-4', 'denied');
  writeCandidate('cand-5', 'live');
  assert.equal(worker.pendingReviewCount(config), 3, 'denied/approved candidates are not pending');

  // --- exactly one active sandbox: runNow rejects when a cycle is already active ---
  // Simulate a live worker by pointing the pid file at THIS process (alive),
  // then mark a cycle active; the one-sandbox guard must reject a second run.
  const p = store.paths(config);
  fs.writeFileSync(p.pidFile, String(process.pid));
  store.updateStatus({
    model_proxy_ready: true,
    state: 'experimenting',
    phase: 'sandbox_agent_running',
    current_run_id: 'rsi-active-1',
    current_container: 'floki-rsi-active-1'
  }, config);

  const live = store.readStatus(config);
  assert.equal(live.worker_running, true, 'pid file makes the worker appear live');

  const token = store.ensureApprovalToken(config);
  let threw = null;
  try {
    await promotion.runNow(token, 'second concurrent run', 'code', config);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'second run rejected');
  assert.ok(/already active/.test(threw.message), 'one-sandbox guard message: ' + threw.message);

  fs.rmSync(p.pidFile, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(JSON.stringify({
    marker: 'FLOKI_V2_RSI_ONE_SANDBOX_PASS',
    multiple_pending_supported: true,
    pending_does_not_block: true,
    queue_full_only_at_cap: true,
    one_active_sandbox_enforced: true
  }, null, 2));
}

main().catch((err) => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.error(err);
  process.exit(1);
});
