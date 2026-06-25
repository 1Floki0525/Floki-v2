'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  appendAudit,
  assertApprovalToken,
  atomicJson,
  ensureLayout,
  listCandidates,
  nowIso,
  patchCandidate,
  paths,
  readCandidate,
  readStatus,
  updateStatus,
  validId
} = require('./store.cjs');
const { stopCurrentContainer } = require('./sandbox.cjs');

function pause(token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const p = ensureLayout(config);
  fs.writeFileSync(p.pauseFile, nowIso() + '\n', { mode: 0o600 });
  stopCurrentContainer('maker_paused', config);
  updateStatus({ state: 'paused', phase: null, paused: true }, config);
  appendAudit('maker_paused_worker', {}, config);
  return readStatus(config);
}

function resume(token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const p = ensureLayout(config);
  fs.rmSync(p.pauseFile, { force: true });
  updateStatus({ state: 'waiting_for_idle', phase: 'resumed', paused: false }, config);
  appendAudit('maker_resumed_worker', {}, config);
  return readStatus(config);
}

function runNow(token, objective = '', config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const p = ensureLayout(config);
  atomicJson(p.runRequestFile, {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_REQUEST',
    requested_at: nowIso(),
    force: true,
    objective: String(objective || '').trim()
  }, config);
  const queuedAt = nowIso();
  const queuedStatus = updateStatus({
    state: 'queued',
    phase: 'maker_requested_cycle',
    current_objective: String(objective || '').trim() || config.default_objective,
    queued_at: queuedAt,
    last_error: null,
    failure_latched_at: null
  }, config);
  appendAudit('maker_requested_cycle', {
    objective: String(objective || '').trim(),
    queued_at: queuedAt
  }, config);
  return {
    ok: true,
    verified: true,
    message: 'Self-improvement cycle queued and verified.',
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_QUEUED',
    status: queuedStatus
  };
}

function denyCandidate(id, token, reason = '', config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const candidate = readCandidate(validId(id, config), config);
  if (candidate.status !== 'pending_review') {
    throw new Error('only pending-review candidates can be denied');
  }
  const next = patchCandidate(id, {
    status: 'denied',
    denied_at: nowIso(),
    denial_reason: String(reason || '').trim()
  }, config);
  updateStatus({
    state: 'waiting_for_idle',
    phase: 'candidate_denied',
    latest_candidate_id: id,
    last_error: null
  }, config);
  appendAudit('candidate_denied_by_maker', { candidate_id: id, reason: next.denial_reason }, config);
  return { ok: true, verified: true, candidate: next };
}

function approveCandidate(id, token, config = loadSelfImprovementConfig()) {
  assertApprovalToken(token, config);
  const candidateId = validId(id, config);
  const candidate = readCandidate(candidateId, config);
  if (candidate.status !== 'pending_review') {
    throw new Error('only pending-review candidates can be approved');
  }
  patchCandidate(candidateId, {
    status: 'approved',
    approved_at: nowIso()
  }, config);
  updateStatus({
    state: 'approved',
    phase: 'promotion_worker_starting',
    promotion: {
      candidate_id: candidateId,
      state: 'approved',
      requested_at: nowIso()
    }
  }, config);
  appendAudit('candidate_approved_by_maker', { candidate_id: candidateId }, config);

  const logFile = path.join(config.runtime_root, config.promotion_log_name);
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [
    path.join(config.project_root, 'src', 'self-improvement', 'promoter.cjs'),
    '--candidate',
    candidateId
  ], {
    cwd: config.project_root,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log]
  });
  child.unref();
  fs.closeSync(log);
  return {
    ok: true,
    verified: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_PROMOTION_STARTED',
    candidate_id: candidateId,
    promotion_pid: child.pid
  };
}

module.exports = {
  approveCandidate,
  denyCandidate,
  pause,
  resume,
  runNow
};
