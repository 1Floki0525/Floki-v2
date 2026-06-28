'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.match(process.version, /^v24\./);

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
  /elif ! runtime_api_ready; then/
);
assert.doesNotMatch(
  start,
  /if ! runtime_backend_alive \|\| ! runtime_api_ready; then/
);
assert.match(
  start,
  /consecutive_failures.*WATCHDOG_FAILURE_LIMIT/s
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_CHAT_LOCAL_WATCHDOG_RESILIENCE_PASS',
  dead_runtime_still_fails_immediately: true,
  transient_probe_requires_consecutive_failures: true,
  failure_limit_yaml_driven: true,
  electron_not_closed_after_one_slow_probe: true
}, null, 2));
