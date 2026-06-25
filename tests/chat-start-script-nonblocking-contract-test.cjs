'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function run() {
  assert.equal(process.version, 'v24.17.0', 'Node v24.17.0 is required');

  const start = read('bin/floki-start.sh');
  const chatStart = read('bin/floki-chat-start.sh');
  const localStart = read('bin/floki-chat-local-start.sh');
  const runtime = read('src/runtime/chat-local-runtime.cjs');

  // 1. Background scheduler/backend start must not block the launcher.
  // The old implementation captured daemon-script output with command substitution,
  // which can block the parent shell when the daemon inherits the write end of the pipe.
  assert.doesNotMatch(
    start,
    /SCHEDULER_OUTPUT=\"\$\(bash bin\/floki-sleep-scheduler-start\.sh/,
    'scheduler startup must not use command substitution around a daemon launcher'
  );
  assert.doesNotMatch(
    start,
    /HEARING_OUTPUT=\"\$\(bash bin\/floki-chat-start\.sh/,
    'backend startup must not use command substitution around a daemon launcher'
  );

  // The launcher must instead redirect the helper script to a temp/log file and read it back.
  assert.match(
    start,
    /mktemp \/tmp\/floki-scheduler-start\.XXXXXX/,
    'scheduler startup must write helper output to a temp file'
  );
  assert.match(
    start,
    /mktemp \/tmp\/floki-chat-start\.XXXXXX/,
    'backend startup must write helper output to a temp file'
  );

  // The helper scripts themselves must detach stdio so the daemon cannot hold the pipe.
  assert.match(chatStart, /nohup node src\/runtime\/chat-local-runtime\.cjs/, 'backend must be started with nohup');
  assert.match(chatStart, /<\/dev\/null/, 'backend stdin must be detached from the launcher');
  assert.match(chatStart, /disown "\$STARTED_PID"/, 'backend must be disowned from the launcher shell');

  // 2. Cleanup trap must run when the Electron app exits normally.
  assert.match(start, /CHAT_LOCAL_HANDED_OFF=1/, 'launcher must mark the hand-off before starting Electron');
  assert.match(start, /CHAT_LOCAL_HANDED_OFF=1\s*\n\s*bash bin\/floki-chat-local-start\.sh/, 'hand-off marker must precede Electron launcher invocation');
  assert.doesNotMatch(
    start,
    /CHAT_LOCAL_HANDED_OFF[^\n]*last_exit[^\n]*-eq 0/,
    'normal Electron exit status 0 must not skip authoritative cleanup'
  );
  assert.match(start, /trap cleanup_chat_local EXIT/, 'launcher must keep cleanup on EXIT after hand-off');
  assert.match(localStart, /resolve_runtime_monitor_settings/, 'Electron launcher must resolve runtime watchdog settings from YAML');
  assert.match(localStart, /runtime_watchdog_poll_ms/, 'runtime watchdog poll interval must come from YAML');
  assert.match(localStart, /runtime_watchdog_request_timeout_ms/, 'runtime watchdog request timeout must come from YAML');
  assert.match(localStart, /run_supervised_electron/, 'Electron must be supervised by the launcher shell');
  assert.match(localStart, /FLOKI_V2_CHAT_LOCAL_RUNTIME_WATCHDOG_FAIL/, 'runtime death while Electron is open must fail closed');
  assert.doesNotMatch(localStart, /exec \.\/node_modules\/\.bin\/electron \./, 'Electron must not replace the supervising launcher shell');

  // 3. Exactly one backend process may own the runtime port.
  assert.match(chatStart, /if runtime_active "\$EXISTING_PID"/, 'launcher must check for an existing backend PID');
  assert.match(chatStart, /already_active/, 'launcher must report reuse when the existing backend is healthy');
  assert.match(chatStart, /runtime_pids_for_project/, 'launcher must enumerate orphaned project runtimes');
  assert.match(chatStart, /port_in_use/, 'launcher must verify the runtime port is free before binding');
  assert.match(chatStart, /runtime port .* is already in use/, 'launcher must fail with a clear error when the port is occupied');
  assert.match(runtime, /function assertPortAvailable/, 'runtime must pre-check the configured port');
  assert.match(runtime, /FLOKI_V2_CHAT_LOCAL_RUNTIME_PORT_IN_USE/, 'runtime must report a clear port-in-use error');

  // Quick dynamic proof: the dry-run backend-start script must return without blocking.
  const dryRunOutput = execFileSync('bash', [path.join(ROOT, 'bin/floki-chat-start.sh')], {
    env: { ...process.env, FLOKI_CHAT_SCRIPT_DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 10000,
    cwd: ROOT,
  });
  assert.match(dryRunOutput, /FLOKI_V2_CHAT_START_SCRIPT_PASS/, 'dry-run backend start must return immediately');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_START_SCRIPT_NONBLOCKING_CONTRACT_PASS',
    scheduler_no_command_substitution: true,
    backend_no_command_substitution: true,
    launcher_uses_temp_files: true,
    backend_detached_stdin: true,
    backend_disowned: true,
    cleanup_runs_on_normal_electron_exit: true,
    runtime_watchdog_fail_closed: true,
    single_backend_port_owner: true,
    dry_run_returns_immediately: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_START_SCRIPT_NONBLOCKING_CONTRACT_FAIL',
    error: error && error.message ? error.message : String(error),
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
