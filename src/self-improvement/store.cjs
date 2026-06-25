'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadSelfImprovementConfig } = require('./config.cjs');

function nowIso() {
  return new Date().toISOString();
}

function atomicJson(file, value, config = loadSelfImprovementConfig()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const suffix = crypto.randomBytes(config.atomic_temp_random_bytes).toString('hex');
  const temp = file + '.tmp-' + process.pid + '-' + suffix;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function safeJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function validId(value, config = loadSelfImprovementConfig()) {
  const id = String(value || '');
  const max = Number(config.candidate_id_max_length);
  if (
    id.length < 1 ||
    id.length > max ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)
  ) {
    throw new Error('invalid self-improvement identifier');
  }
  return id;
}

function paths(config = loadSelfImprovementConfig()) {
  return Object.freeze({
    statusFile: path.join(config.runtime_root, config.status_file_name),
    pidFile: path.join(config.runtime_root, config.worker_pid_file_name),
    pauseFile: path.join(config.runtime_root, config.pause_file_name),
    runRequestFile: path.join(config.runtime_root, config.run_request_file_name),
    currentContainerFile: path.join(config.runtime_root, config.current_container_file_name),
    auditFile: path.join(config.runtime_root, config.audit_file_name),
    tokenFile: path.join(config.runtime_root, config.approval_token_file_name),
    promotionLock: path.join(config.runtime_root, config.promotion_lock_file_name)
  });
}

function ensureLayout(config = loadSelfImprovementConfig()) {
  for (const dir of [
    config.workspace_root,
    config.candidate_root,
    config.outbox_root,
    config.runtime_root
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths(config);
}

function defaultStatus(config = loadSelfImprovementConfig()) {
  return {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_STATUS',
    enabled: config.enabled === true,
    state: config.enabled === true ? 'waiting_for_idle' : 'disabled',
    phase: null,
    paused: false,
    worker_running: false,
    worker_alive_at: null,
    sandbox_alive_at: null,
    current_run_id: null,
    current_objective: null,
    current_container: null,
    started_at: null,
    last_heartbeat_at: null,
    last_cycle_started_at: null,
    last_cycle_completed_at: null,
    last_error: null,
    failure_latched_at: null,
    last_no_candidate_at: null,
    last_no_candidate_error: null,
    last_sandbox_log_file: null,
    model_proxy_ready: false,
    queued_at: null,
    pending_review_count: 0,
    latest_candidate_id: null,
    promotion: null,
    ui_poll_ms: config.ui_poll_ms,
    current_command: null,
    current_command_started_at: null,
    current_command_elapsed_ms: 0,
    last_real_progress_at: null,
    stalled: false
  };
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function readStatus(config = loadSelfImprovementConfig()) {
  const p = ensureLayout(config);
  const current = safeJson(p.statusFile, defaultStatus(config));
  const pid = Number(String((() => {
    try { return fs.readFileSync(p.pidFile, 'utf8'); } catch (_error) { return ''; }
  })()).trim());
  const workerHeartbeat = readWorkerHeartbeat(config);
  const sandboxHeartbeat = readSandboxHeartbeat(config);
  return Object.freeze({
    ...defaultStatus(config),
    ...(current || {}),
    enabled: config.enabled === true,
    paused: fs.existsSync(p.pauseFile),
    worker_running: processAlive(pid),
    worker_pid: processAlive(pid) ? pid : null,
    worker_alive_at: workerHeartbeat ? workerHeartbeat.observed_at : null,
    sandbox_alive_at: sandboxHeartbeat ? sandboxHeartbeat.observed_at : null,
    ui_poll_ms: config.ui_poll_ms,
    pending_review_count: listCandidates(config)
      .filter((candidate) => [
        'pending_review',
        'approved',
        'validating',
        'deploying'
      ].includes(candidate.status))
      .length
  });
}

function updateStatus(patch, config = loadSelfImprovementConfig()) {
  const p = ensureLayout(config);
  const current = safeJson(p.statusFile, {}) || {};
  const patchWithHeartbeat = (patch && Object.prototype.hasOwnProperty.call(patch, 'last_heartbeat_at'))
    ? patch
    : { ...(patch || {}), last_heartbeat_at: nowIso() };
  const next = {
    ...defaultStatus(config),
    ...current,
    ...patchWithHeartbeat,
    ui_poll_ms: config.ui_poll_ms
  };
  atomicJson(p.statusFile, next, config);
  return Object.freeze(next);
}

function touchWorkerHeartbeat(config = loadSelfImprovementConfig()) {
  const p = ensureLayout(config);
  const file = path.join(config.runtime_root, config.worker_heartbeat_file_name || 'worker.heartbeat.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const observed = nowIso();
  fs.writeFileSync(file, JSON.stringify({
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_WORKER_HEARTBEAT',
    pid: process.pid,
    observed_at: observed,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2) + '\n', { mode: 0o600 });
  const current = safeJson(p.statusFile, {}) || {};
  const nowPatch = { last_heartbeat_at: observed };
  if (current.worker_alive_at !== observed) nowPatch.worker_alive_at = observed;
  atomicJson(p.statusFile, { ...current, ...nowPatch }, config);
}

function readWorkerHeartbeat(config = loadSelfImprovementConfig()) {
  const file = path.join(config.runtime_root, config.worker_heartbeat_file_name || 'worker.heartbeat.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return null; }
}

function touchSandboxHeartbeat(config = loadSelfImprovementConfig(), runId) {
  const p = ensureLayout(config);
  const file = path.join(config.runtime_root, config.sandbox_heartbeat_file_name || 'sandbox.heartbeat.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const observed = nowIso();
  fs.writeFileSync(file, JSON.stringify({
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_SANDBOX_HEARTBEAT',
    pid: process.pid,
    run_id: runId || null,
    observed_at: observed,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2) + '\n', { mode: 0o600 });
  const current = safeJson(p.statusFile, {}) || {};
  const nowPatch = { last_heartbeat_at: observed };
  if (current.sandbox_alive_at !== observed) nowPatch.sandbox_alive_at = observed;
  atomicJson(p.statusFile, { ...current, ...nowPatch }, config);
}

function readSandboxHeartbeat(config = loadSelfImprovementConfig()) {
  const file = path.join(config.runtime_root, config.sandbox_heartbeat_file_name || 'sandbox.heartbeat.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return null; }
}

function appendAudit(type, detail = {}, config = loadSelfImprovementConfig()) {
  const p = ensureLayout(config);
  const record = {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_AUDIT',
    created_at: nowIso(),
    type: String(type || 'event'),
    detail
  };
  fs.appendFileSync(p.auditFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

function candidateDir(id, config = loadSelfImprovementConfig()) {
  return path.join(config.candidate_root, validId(id, config));
}

function readCandidate(id, config = loadSelfImprovementConfig()) {
  const dir = candidateDir(id, config);
  const manifest = safeJson(path.join(dir, 'manifest.json'));
  if (!manifest) throw new Error('candidate not found: ' + id);
  return Object.freeze({
    ...manifest,
    summary_markdown: (() => {
      try { return fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); } catch (_error) { return ''; }
    })(),
    architecture_decision_markdown: (() => {
      try { return fs.readFileSync(path.join(dir, 'architecture-decision.md'), 'utf8'); } catch (_error) { return ''; }
    })(),
    diff: (() => {
      try { return fs.readFileSync(path.join(dir, 'changes.diff'), 'utf8'); } catch (_error) { return ''; }
    })(),
    research_sources: safeJson(path.join(dir, 'research-sources.json'), []),
    test_results: safeJson(path.join(dir, 'test-results.json'), []),
    benchmark_results: safeJson(path.join(dir, 'benchmark-results.json'), []),
    command_audit: (() => {
      try {
        return fs.readFileSync(path.join(dir, 'command-audit.jsonl'), 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (_error) {
        return [];
      }
    })()
  });
}

function listCandidates(config = loadSelfImprovementConfig()) {
  ensureLayout(config);
  const rows = [];
  for (const entry of fs.readdirSync(config.candidate_root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = safeJson(path.join(config.candidate_root, entry.name, 'manifest.json'));
    if (manifest) rows.push(manifest);
  }
  return rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function patchCandidate(id, patch, config = loadSelfImprovementConfig()) {
  const dir = candidateDir(id, config);
  const file = path.join(dir, 'manifest.json');
  const current = safeJson(file);
  if (!current) throw new Error('candidate not found: ' + id);
  const next = {
    ...current,
    ...(patch || {}),
    updated_at: nowIso()
  };
  atomicJson(file, next, config);
  appendAudit('candidate_status_changed', {
    candidate_id: id,
    previous_status: current.status,
    next_status: next.status
  }, config);
  return Object.freeze(next);
}

function importOutbox(runId, config = loadSelfImprovementConfig()) {
  const id = validId(runId, config);
  const source = path.join(config.outbox_root, id);
  const manifest = safeJson(path.join(source, 'manifest.json'));
  if (!manifest || manifest.id !== id || manifest.status !== 'pending_review') {
    throw new Error('sandbox did not produce a valid pending-review candidate');
  }
  const required = [
    'manifest.json',
    'summary.md',
    'architecture-decision.md',
    'changes.diff',
    'research-sources.json',
    'test-results.json',
    'benchmark-results.json',
    'command-audit.jsonl'
  ];
  for (const name of required) {
    if (!fs.existsSync(path.join(source, name))) {
      throw new Error('candidate output missing ' + name);
    }
  }
  const diff = fs.readFileSync(path.join(source, 'changes.diff'));
  const actualPatchSha = crypto.createHash('sha256').update(diff).digest('hex');
  if (actualPatchSha !== manifest.patch_sha256) {
    throw new Error('candidate patch hash mismatch');
  }
  const target = candidateDir(id, config);
  if (fs.existsSync(target)) throw new Error('candidate already exists: ' + id);
  fs.renameSync(source, target);
  appendAudit('candidate_imported', { candidate_id: id, patch_sha256: actualPatchSha }, config);
  updateStatus({
    state: 'pending_review',
    phase: 'awaiting_maker_decision',
    current_run_id: null,
    current_container: null,
    latest_candidate_id: id,
    last_cycle_completed_at: nowIso(),
    last_error: null
  }, config);
  return readCandidate(id, config);
}

function ensureApprovalToken(config = loadSelfImprovementConfig()) {
  const p = ensureLayout(config);
  if (!fs.existsSync(p.tokenFile)) {
    try {
      fs.writeFileSync(
        p.tokenFile,
        crypto.randomBytes(config.approval_token_bytes).toString('hex') + '\n',
        { mode: 0o600, flag: 'wx' }
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  fs.chmodSync(p.tokenFile, 0o600);
  return fs.readFileSync(p.tokenFile, 'utf8').trim();
}

function assertApprovalToken(value, config = loadSelfImprovementConfig()) {
  const supplied = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(ensureApprovalToken(config), 'utf8');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new Error('self-improvement approval authorization failed');
  }
  return true;
}

module.exports = {
  appendAudit,
  assertApprovalToken,
  atomicJson,
  candidateDir,
  defaultStatus,
  ensureApprovalToken,
  ensureLayout,
  importOutbox,
  listCandidates,
  nowIso,
  patchCandidate,
  paths,
  processAlive,
  readCandidate,
  readSandboxHeartbeat,
  readStatus,
  readWorkerHeartbeat,
  safeJson,
  touchSandboxHeartbeat,
  touchWorkerHeartbeat,
  updateStatus,
  validId
};
