'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

assert.match(process.version, /^v24\./, 'Node 24.x is required');

const ROOT = path.resolve(__dirname, '..');
const {
  atomicWriteJson,
  authorizeCleanup,
  isChatLocalLauncherActive,
  readSession,
  releaseSession
} = require('../src/runtime/chat-local-supervisor-lease.cjs');

function createFakeLauncher(procRoot, pid, projectRoot) {
  const base = path.join(procRoot, String(pid));
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(base, 'cmdline'),
    Buffer.from(
      'bash\0' +
      path.join(projectRoot, 'bin/floki-start.sh') +
      '\0chat.local\0'
    )
  );
  fs.symlinkSync(projectRoot, path.join(base, 'cwd'));
}

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'floki-chat-supervisor-ownership-')
);
const projectRoot = path.join(tempRoot, 'repo');
const procRoot = path.join(tempRoot, 'proc');
const sessionFile = path.join(
  tempRoot,
  'runtime',
  'chat-local-supervisor-session.json'
);

try {
  fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(procRoot, { recursive: true, mode: 0o700 });

  const activePid = 4242;
  createFakeLauncher(procRoot, activePid, projectRoot);
  atomicWriteJson(sessionFile, {
    marker: 'FLOKI_V2_CHAT_LOCAL_SUPERVISOR_SESSION',
    session_id: 'new-session',
    launcher_pid: activePid,
    runtime_pid: 5252,
    project_root: projectRoot,
    started_at: new Date().toISOString()
  });

  const activeSession = readSession(sessionFile);
  assert.equal(
    isChatLocalLauncherActive(activeSession, procRoot),
    true,
    'fixture must represent an active chat.local supervisor'
  );

  const staleOwner = authorizeCleanup({
    session_file: sessionFile,
    requested_session_id: 'old-session',
    proc_root: procRoot
  });
  assert.equal(staleOwner.authorized, false);
  assert.equal(
    staleOwner.reason,
    'supervisor_session_ownership_mismatch',
    'an older supervisor must not clean up a newer session'
  );

  const ownerlessCleanup = authorizeCleanup({
    session_file: sessionFile,
    requested_session_id: '',
    proc_root: procRoot
  });
  assert.equal(ownerlessCleanup.authorized, false);
  assert.equal(
    ownerlessCleanup.reason,
    'active_supervisor_requires_owner_session',
    'manual or legacy cleanup must not kill an active owned session'
  );

  const correctOwner = authorizeCleanup({
    session_file: sessionFile,
    requested_session_id: 'new-session',
    proc_root: procRoot
  });
  assert.equal(correctOwner.authorized, true);
  assert.equal(
    correctOwner.reason,
    'supervisor_session_owner_match'
  );

  const wrongRelease = releaseSession({
    session_file: sessionFile,
    requested_session_id: 'old-session',
    proc_root: procRoot
  });
  assert.equal(wrongRelease.removed, false);
  assert.equal(fs.existsSync(sessionFile), true);

  const correctRelease = releaseSession({
    session_file: sessionFile,
    requested_session_id: 'new-session',
    proc_root: procRoot
  });
  assert.equal(correctRelease.removed, true);
  assert.equal(fs.existsSync(sessionFile), false);

  atomicWriteJson(sessionFile, {
    marker: 'FLOKI_V2_CHAT_LOCAL_SUPERVISOR_SESSION',
    session_id: 'stale-session',
    launcher_pid: 9999,
    runtime_pid: 9998,
    project_root: projectRoot,
    started_at: new Date().toISOString()
  });

  const staleAuthorization = authorizeCleanup({
    session_file: sessionFile,
    requested_session_id: '',
    proc_root: procRoot
  });
  assert.equal(staleAuthorization.authorized, true);
  assert.equal(staleAuthorization.reason, 'stale_supervisor_session');

  const start = fs.readFileSync(
    path.join(ROOT, 'bin/floki-start.sh'),
    'utf8'
  );
  const cleanup = fs.readFileSync(
    path.join(ROOT, 'bin/floki-chat-local-cleanup.sh'),
    'utf8'
  );

  const acquireIndex = start.indexOf(
    'acquire_chat_local_supervisor_lease'
  );
  const stageOneIndex = start.indexOf(
    'startup_stage "1/7"'
  );
  assert.ok(acquireIndex >= 0);
  assert.ok(stageOneIndex > acquireIndex);
  assert.match(
    start,
    /flock -n 9/,
    'chat.local must hold an exclusive nonblocking supervisor lock'
  );
  assert.match(
    start,
    /chat-local-supervisor-lease\.cjs\s+claim/,
    'chat.local must claim a unique supervisor session'
  );
  assert.match(
    start,
    /chat-local-supervisor-lease\.cjs\s+set-runtime/,
    'chat.local must record the runtime PID it owns'
  );

  const authorizationMatch = cleanup.match(
    /chat-local-supervisor-lease\.cjs\s+authorize-cleanup/
  );
  const authorizationIndex = authorizationMatch
    ? authorizationMatch.index
    : -1;
  const stopIndex = cleanup.indexOf(
    'bash bin/floki-chat-stop.sh'
  );
  assert.ok(
    authorizationIndex >= 0,
    'cleanup must invoke the ownership authorization command'
  );
  assert.ok(
    stopIndex > authorizationIndex,
    'cleanup ownership must be authorized before any runtime stop'
  );
  assert.match(
    cleanup,
    /FLOKI_V2_CHAT_LOCAL_CLEANUP_SKIPPED/,
    'stale cleanup must exit successfully without touching the new runtime'
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_SUPERVISOR_OWNERSHIP_CONTRACT_PASS',
    stale_supervisor_cleanup_blocked: true,
    ownerless_active_cleanup_blocked: true,
    matching_owner_cleanup_allowed: true,
    stale_session_cleanup_allowed: true,
    exclusive_supervisor_lock_required: true,
    runtime_pid_ownership_recorded: true
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
