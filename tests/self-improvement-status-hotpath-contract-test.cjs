'use strict';

// Contract: readStatus() must NOT scan/parse every candidate manifest on the
// hot path. The runtime /status endpoint (polled ~1/s by the launcher watchdog)
// calls readStatus(); an O(candidates) synchronous scan there starves the
// runtime under sandbox CPU load and trips the watchdog, which tears down the
// app. readStatus() must read the PERSISTED pending_review_count; the count is
// recomputed only by refreshPendingReviewCount() when candidates change.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const {
  readStatus,
  updateStatus,
  refreshPendingReviewCount
} = require('../src/self-improvement/store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-hotpath-'));
const base = loadSelfImprovementConfig();
const config = Object.freeze({
  ...base,
  workspace_root: path.join(root, 'workspaces'),
  candidate_root: path.join(root, 'candidates'),
  outbox_root: path.join(root, 'outbox'),
  runtime_root: path.join(root, 'runtime')
});

function writeCandidate(id, status) {
  const dir = path.join(config.candidate_root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, status, created_at: new Date().toISOString() })
  );
}

// Seed a persisted status with a deliberately WRONG count vs. actual manifests.
updateStatus({ state: 'waiting_for_idle', pending_review_count: 5 }, config);
// Create only 2 pending candidates on disk (and noise that must not be counted).
writeCandidate('c1', 'pending_review');
writeCandidate('c2', 'pending_review');
writeCandidate('c3', 'denied');
writeCandidate('c4', 'promoted');

// readStatus must return the PERSISTED value (5), proving it does NOT rescan
// the manifests on the hot path.
const s1 = readStatus(config);
assert.equal(
  s1.pending_review_count,
  5,
  'readStatus must read the persisted count, not rescan candidate manifests'
);

// refreshPendingReviewCount recomputes from disk: 2 pending_review (denied and
// promoted excluded) and persists it.
const refreshed = refreshPendingReviewCount(config);
assert.equal(refreshed, 2, 'refresh must count only active/pending statuses');

// After refresh, readStatus reflects the corrected, persisted value.
const s2 = readStatus(config);
assert.equal(
  s2.pending_review_count,
  2,
  'readStatus reflects the persisted refreshed count'
);

// Adding more pending candidates on disk must NOT change readStatus until a
// refresh occurs — proving readStatus never scans on the hot path.
writeCandidate('c5', 'pending_review');
writeCandidate('c6', 'pending_review');
const s3 = readStatus(config);
assert.equal(
  s3.pending_review_count,
  2,
  'readStatus stays at the persisted value (no hot-path rescan) until refresh'
);
assert.equal(refreshPendingReviewCount(config), 4, 'refresh picks up new candidates');

fs.rmSync(root, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_STATUS_HOTPATH_CONTRACT_PASS',
  read_status_uses_persisted_count: true,
  no_hot_path_manifest_scan: true,
  refresh_recomputes_on_demand: true
}, null, 2));
