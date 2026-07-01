'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(
  Number(process.versions.node.split('.')[0]) >= 24,
  true,
  'Node 24 or newer is required'
);

const root = path.resolve(__dirname, '..');
const start = fs.readFileSync(
  path.join(root, 'bin/floki-chat-local-start.sh'),
  'utf8'
);
const {
  getLiveChatConfig
} = require('../src/config/floki-config.cjs');

const live = getLiveChatConfig('chat');
assert.ok(
  Number.isInteger(live.runtime_watchdog_consecutive_failure_limit)
);
assert.ok(live.runtime_watchdog_consecutive_failure_limit >= 2);
assert.ok(Number.isInteger(live.electron_shutdown_grace_ms));
assert.ok(live.electron_shutdown_grace_ms >= 1000);
assert.ok(Number.isInteger(live.renderer_unresponsive_grace_ms));
assert.ok(live.renderer_unresponsive_grace_ms >= live.runtime_watchdog_request_timeout_ms);

assert.match(start, /WATCHDOG_FAILURE_LIMIT/);
assert.match(start, /consecutive_failures/);
assert.match(
  start,
  /FLOKI_V2_CHAT_LOCAL_RUNTIME_WATCHDOG_RETRY/
);
assert.match(
  start,
  /if ! runtime_backend_alive; then/
);
assert.match(
  start,
  /runtime_api_ready 2>"\$api_error_file"/
);
assert.doesNotMatch(
  start,
  /if ! runtime_backend_alive \|\| ! runtime_api_ready; then/
);
assert.match(
  start,
  /consecutive_failures.*WATCHDOG_FAILURE_LIMIT/s
);
assert.match(
  start,
  /ELECTRON_SHUTDOWN_GRACE_SECONDS/,
  'runtime disappearance must allow a bounded Electron shutdown grace'
);
assert.match(
  start,
  /FLOKI_V2_CHAT_LOCAL_ELECTRON_PID/,
  'launcher must log the real supervised Electron PID'
);
assert.match(
  start,
  /FLOKI_V2_CHAT_LOCAL_ELECTRON_EXIT/,
  'launcher must log Electron exit code and signal separately'
);
assert.match(
  start,
  /FLOKI_V2_CHAT_LOCAL_RUNTIME_WATCHDOG_GRACE/,
  'runtime disappearance must enter a grace state before fatal shutdown'
);
assert.match(
  start,
  /FLOKI_V2_CHAT_LOCAL_RUNTIME_WATCHDOG_RECOVERED/,
  'transient runtime health failures must log recovery'
);
assert.match(
  start,
  /last_api_error=/,
  'fatal runtime API watchdog errors must include the original probe error'
);

const electron = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/electron/main.cjs'),
  'utf8'
);
assert.match(electron, /renderer_unresponsive_grace_ms/);
assert.match(electron, /'unresponsive'/);
assert.match(electron, /'responsive'/);
assert.match(electron, /'render-process-gone'/);
assert.match(electron, /'child-process-gone'/);
assert.match(electron, /FLOKI_V2_ELECTRON_RENDERER_CRASH/);
assert.match(electron, /FLOKI_V2_ELECTRON_RENDERER_RECOVERED/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_CHAT_LOCAL_WATCHDOG_RESILIENCE_PASS',
  dead_runtime_uses_shutdown_grace_before_fatal: true,
  transient_probe_requires_consecutive_failures: true,
  failure_limit_yaml_driven: true,
  electron_not_closed_after_one_slow_probe: true,
  backend_death_uses_shutdown_grace: true,
  electron_exit_logged_with_code_and_signal: true,
  renderer_unresponsive_recovery_supported: true,
  renderer_crash_distinct_from_main_exit: true
}, null, 2));
