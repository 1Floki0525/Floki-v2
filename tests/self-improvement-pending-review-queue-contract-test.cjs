'use strict';

// Contract: a candidate awaiting Maker review must NOT stop Floki from running
// more RSI cycles. The pending-review queue accumulates up to
// max_pending_review_candidates so the Maker returns to a batch of candidates.
// Only an active promotion (approved/validating/deploying) blocks a new cycle.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  promotionInProgress,
  pendingReviewCount,
  pendingReviewQueueFull,
  pendingCandidateExists
} = require('../src/self-improvement/worker.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-queue-'));
const candidateRoot = path.join(root, 'candidates');

function baseConfig(maxPending) {
  return {
    workspace_root: path.join(root, 'workspaces'),
    candidate_root: candidateRoot,
    outbox_root: path.join(root, 'outbox'),
    runtime_root: path.join(root, 'runtime'),
    status_file_name: 'status.json',
    worker_pid_file_name: 'worker.pid',
    pause_file_name: 'pause',
    run_request_file_name: 'run-request.json',
    current_container_file_name: 'current-container',
    audit_file_name: 'audit.jsonl',
    approval_token_file_name: 'token',
    promotion_lock_file_name: 'promotion.lock',
    max_pending_review_candidates: maxPending
  };
}

function resetCandidates() {
  fs.rmSync(candidateRoot, { recursive: true, force: true });
  fs.mkdirSync(candidateRoot, { recursive: true });
}

let seq = 0;
function writeCandidate(status) {
  seq += 1;
  const id = 'rsi-cand-' + String(seq).padStart(4, '0');
  const dir = path.join(candidateRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      status,
      created_at: new Date(Date.now() + seq * 1000).toISOString()
    })
  );
  return id;
}

// 1. Empty queue: nothing blocks, nothing pending.
resetCandidates();
let config = baseConfig(10);
assert.equal(pendingReviewCount(config), 0, 'empty queue counts zero');
assert.equal(promotionInProgress(config), false, 'no promotion when empty');
assert.equal(pendingReviewQueueFull(config), false, 'empty queue is not full');
assert.equal(pendingCandidateExists(config), false, 'nothing pending when empty');

// 2. One pending_review candidate: queue is NOT full, new cycles still allowed.
resetCandidates();
writeCandidate('pending_review');
config = baseConfig(10);
assert.equal(pendingReviewCount(config), 1, 'one pending review counted');
assert.equal(
  pendingReviewQueueFull(config),
  false,
  'a single pending candidate must NOT block new cycles'
);
assert.equal(
  promotionInProgress(config),
  false,
  'pending_review is not an active promotion'
);
assert.equal(
  pendingCandidateExists(config),
  true,
  'backward-compat: a pending candidate exists'
);

// 3. Queue accumulates up to the cap; only at/over the cap does it block.
resetCandidates();
config = baseConfig(3);
writeCandidate('pending_review');
writeCandidate('pending_review');
assert.equal(pendingReviewQueueFull(config), false, '2 of 3 is not full');
writeCandidate('pending_review');
assert.equal(pendingReviewCount(config), 3, 'three pending reviews counted');
assert.equal(
  pendingReviewQueueFull(config),
  true,
  'queue is full at the configured cap'
);

// 4. Denied / approved-and-done candidates do not count toward the queue.
resetCandidates();
config = baseConfig(3);
writeCandidate('denied');
writeCandidate('denied');
writeCandidate('promoted');
assert.equal(
  pendingReviewCount(config),
  0,
  'denied and promoted candidates are not pending review'
);
assert.equal(
  pendingReviewQueueFull(config),
  false,
  'resolved candidates never fill the review queue'
);

// 5. Active promotion always blocks, regardless of queue size.
for (const promotingStatus of ['approved', 'validating', 'deploying']) {
  resetCandidates();
  config = baseConfig(10);
  writeCandidate(promotingStatus);
  assert.equal(
    promotionInProgress(config),
    true,
    promotingStatus + ' counts as an active promotion'
  );
  assert.equal(
    pendingCandidateExists(config),
    true,
    promotingStatus + ' is a candidate that exists'
  );
}

fs.rmSync(root, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_PENDING_REVIEW_QUEUE_CONTRACT_PASS',
  pending_review_accumulates: true,
  single_pending_does_not_block: true,
  promotion_always_blocks: true
}, null, 2));
