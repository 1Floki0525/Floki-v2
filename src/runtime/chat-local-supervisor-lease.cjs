'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readSession(sessionFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (
      !parsed ||
      typeof parsed.session_id !== 'string' ||
      parsed.session_id.trim() === '' ||
      !Number.isInteger(Number(parsed.launcher_pid)) ||
      typeof parsed.project_root !== 'string' ||
      parsed.project_root.trim() === ''
    ) {
      return null;
    }
    return Object.freeze({
      ...parsed,
      launcher_pid: Number(parsed.launcher_pid),
      runtime_pid: parsed.runtime_pid == null
        ? null
        : Number(parsed.runtime_pid)
    });
  } catch (_error) {
    return null;
  }
}

function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.tmp-' + process.pid + '-' +
    crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(
    temporary,
    JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600 }
  );
  fs.renameSync(temporary, target);
}

function processSnapshot(pid, procRoot = '/proc') {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const base = path.join(procRoot, String(numericPid));
  try {
    const argv = fs.readFileSync(path.join(base, 'cmdline'))
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const cwd = fs.readlinkSync(path.join(base, 'cwd'));
    return Object.freeze({ pid: numericPid, argv, cwd });
  } catch (_error) {
    return null;
  }
}

function isChatLocalLauncherActive(session, procRoot = '/proc') {
  if (!session) return false;
  const processInfo = processSnapshot(session.launcher_pid, procRoot);
  if (!processInfo) return false;

  const expectedRoot = path.resolve(session.project_root);
  if (path.resolve(processInfo.cwd) !== expectedRoot) return false;

  const hasLauncher = processInfo.argv.some((argument) => {
    const normalized = String(argument || '').replace(/\\/g, '/');
    return normalized === 'bin/floki-start.sh' ||
      normalized.endsWith('/bin/floki-start.sh');
  });
  const hasChatLocal = processInfo.argv.includes('chat.local');
  return hasLauncher && hasChatLocal;
}

function claimSession(options = {}) {
  const sessionFile = path.resolve(options.session_file);
  const launcherPid = Number(options.launcher_pid);
  const projectRoot = path.resolve(options.project_root);

  if (!Number.isInteger(launcherPid) || launcherPid <= 0) {
    throw new Error('launcher_pid must be a positive integer');
  }

  const existing = readSession(sessionFile);
  if (existing && isChatLocalLauncherActive(existing, options.proc_root || '/proc')) {
    const error = new Error(
      'another chat.local supervisor is active: pid=' +
      String(existing.launcher_pid)
    );
    error.code = 'FLOKI_CHAT_LOCAL_SUPERVISOR_ALREADY_ACTIVE';
    throw error;
  }

  const session = Object.freeze({
    marker: 'FLOKI_V2_CHAT_LOCAL_SUPERVISOR_SESSION',
    session_id: crypto.randomBytes(16).toString('hex'),
    launcher_pid: launcherPid,
    runtime_pid: null,
    project_root: projectRoot,
    started_at: new Date().toISOString()
  });
  atomicWriteJson(sessionFile, session);
  return session;
}

function setRuntimePid(options = {}) {
  const sessionFile = path.resolve(options.session_file);
  const sessionId = String(options.session_id || '');
  const runtimePid = Number(options.runtime_pid);
  const session = readSession(sessionFile);

  if (!session || session.session_id !== sessionId) {
    throw new Error('chat.local supervisor session ownership mismatch');
  }
  if (!Number.isInteger(runtimePid) || runtimePid <= 0) {
    throw new Error('runtime_pid must be a positive integer');
  }

  const updated = Object.freeze({
    ...session,
    runtime_pid: runtimePid,
    runtime_recorded_at: new Date().toISOString()
  });
  atomicWriteJson(sessionFile, updated);
  return updated;
}

function authorizeCleanup(options = {}) {
  const sessionFile = path.resolve(options.session_file);
  const requestedSessionId = String(options.requested_session_id || '');
  const procRoot = options.proc_root || '/proc';
  const session = readSession(sessionFile);

  if (requestedSessionId) {
    if (!session) {
      return Object.freeze({
        authorized: false,
        reason: 'supervisor_session_missing'
      });
    }
    if (session.session_id !== requestedSessionId) {
      return Object.freeze({
        authorized: false,
        reason: 'supervisor_session_ownership_mismatch',
        active_session_id: session.session_id,
        requested_session_id: requestedSessionId
      });
    }
    return Object.freeze({
      authorized: true,
      reason: 'supervisor_session_owner_match',
      session
    });
  }

  if (session && isChatLocalLauncherActive(session, procRoot)) {
    return Object.freeze({
      authorized: false,
      reason: 'active_supervisor_requires_owner_session',
      active_session_id: session.session_id,
      launcher_pid: session.launcher_pid
    });
  }

  return Object.freeze({
    authorized: true,
    reason: session
      ? 'stale_supervisor_session'
      : 'no_supervisor_session',
    session
  });
}

function releaseSession(options = {}) {
  const sessionFile = path.resolve(options.session_file);
  const requestedSessionId = String(options.requested_session_id || '');
  const procRoot = options.proc_root || '/proc';
  const session = readSession(sessionFile);

  if (!session) {
    return Object.freeze({ removed: false, reason: 'already_missing' });
  }

  if (requestedSessionId) {
    if (session.session_id !== requestedSessionId) {
      return Object.freeze({
        removed: false,
        reason: 'supervisor_session_ownership_mismatch'
      });
    }
  } else if (isChatLocalLauncherActive(session, procRoot)) {
    return Object.freeze({
      removed: false,
      reason: 'active_supervisor_requires_owner_session'
    });
  }

  fs.rmSync(sessionFile, { force: true });
  return Object.freeze({ removed: true, reason: 'released' });
}

function main(argv = process.argv.slice(2)) {
  const [command, sessionFile, first, second, third] = argv;

  if (command === 'claim') {
    const result = claimSession({
      session_file: sessionFile,
      launcher_pid: Number(first),
      project_root: second,
      proc_root: third || '/proc'
    });
    process.stdout.write(result.session_id + '\n');
    return;
  }

  if (command === 'set-runtime') {
    const result = setRuntimePid({
      session_file: sessionFile,
      session_id: first,
      runtime_pid: Number(second)
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_OWNERSHIP_RECORDED',
      runtime_pid: result.runtime_pid
    }) + '\n');
    return;
  }

  if (command === 'authorize-cleanup') {
    const result = authorizeCleanup({
      session_file: sessionFile,
      requested_session_id: first || '',
      proc_root: second || '/proc'
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.authorized) process.exitCode = 3;
    return;
  }

  if (command === 'release') {
    const result = releaseSession({
      session_file: sessionFile,
      requested_session_id: first || '',
      proc_root: second || '/proc'
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  throw new Error(
    'usage: chat-local-supervisor-lease.cjs ' +
    '<claim|set-runtime|authorize-cleanup|release> ...'
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_LOCAL_SUPERVISOR_LEASE_FAIL',
      error: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : null
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  atomicWriteJson,
  authorizeCleanup,
  claimSession,
  isChatLocalLauncherActive,
  processSnapshot,
  readSession,
  releaseSession,
  setRuntimePid
};
