"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

assert.equal(
  Number(process.versions.node.split('.')[0]) >= 24,
  true,
  'Node 24 or newer is required'
);

const runtimeCommand = read('bin/floki-runtime.sh');
const chatStart = read('bin/floki-chat-start.sh');
const app = read('bin/floki-app.sh');
const localStart = read('bin/floki-chat-local-start.sh');
const runtime = read('src/runtime/chat-local-runtime.cjs');

assert.match(runtimeCommand, /start_runtime_owner/);
assert.match(
  runtimeCommand,
  /run_helper_if_present "floki-chat-start\.sh"/
);
assert.doesNotMatch(
  runtimeCommand,
  /\$\(\s*bash .*floki-chat-start\.sh/
);
assert.match(
  runtimeCommand,
  /run_helper_if_present "floki-sleep-scheduler-start\.sh"/
);

assert.match(
  chatStart,
  /nohup node src\/runtime\/chat-local-runtime\.cjs/
);
assert.match(chatStart, /<\/dev\/null/);
assert.match(chatStart, /disown "\$STARTED_PID"/);
assert.match(chatStart, /ensure_sleep_scheduler/);
assert.match(
  chatStart,
  /mktemp \/tmp\/floki-chat-scheduler-start\.XXXXXX/
);
assert.match(chatStart, /runtime_pids_for_project/);
assert.match(chatStart, /port_in_use/);
assert.match(
  runtime,
  /FLOKI_V2_CHAT_LOCAL_RUNTIME_PORT_IN_USE/
);

assert.match(app, /runtime_autostart=false/);
assert.match(app, /runtime_ready \|\| fail/);
assert.match(app, /runtime_autostart=false/);
assert.doesNotMatch(
  app,
  /^\s*(?:exec\s+)?(?:bash\s+)?(?:"?\$ROOT\/bin\/floki-runtime\.sh"?|(?:\.\/)?bin\/floki-runtime\.sh)\s+start\b/m,
  'floki.app must not execute the shared runtime start command'
);
assert.match(app, /setsid bash "\$ROOT\/bin\/floki-chat-local-start\.sh"/);

assert.match(localStart, /resolve_runtime_monitor_settings/);
assert.match(localStart, /runtime_watchdog_poll_ms/);
assert.match(localStart, /runtime_watchdog_request_timeout_ms/);
assert.match(localStart, /run_supervised_electron/);
assert.match(
  localStart,
  /FLOKI_V2_CHAT_LOCAL_RUNTIME_WATCHDOG_FAIL/
);
assert.doesNotMatch(
  localStart,
  /exec \.\/node_modules\/\.bin\/electron \./
);

const backendDryRun = execFileSync(
  'bash',
  [path.join(ROOT, 'bin/floki-chat-start.sh')],
  {
    env: { ...process.env, FLOKI_CHAT_SCRIPT_DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 10000,
    cwd: ROOT
  }
);
assert.match(
  backendDryRun,
  /FLOKI_V2_CHAT_START_SCRIPT_PASS/
);

const resetDryRun = execFileSync(
  'bash',
  [path.join(ROOT, 'bin/floki-runtime.sh'), 'reset'],
  {
    env: { ...process.env, FLOKI_COMMANDS_DRY_RUN: '1' },
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT
  }
);
assert.match(resetDryRun, /FLOKI_RUNTIME_STOP_DRY_RUN/);
assert.match(resetDryRun, /FLOKI_RUNTIME_START_DRY_RUN/);
assert.match(resetDryRun, /FLOKI_RUNTIME_RESET_PASS/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_CHAT_START_SCRIPT_NONBLOCKING_CONTRACT_PASS',
  runtime_authority_nonblocking: true,
  backend_detached_stdin: true,
  backend_disowned: true,
  app_is_client_only: true,
  runtime_watchdog_fail_closed: true,
  single_backend_port_owner: true,
  reset_dry_run_returns_immediately: true,
  live_runtime_started_by_test: false
}, null, 2));
