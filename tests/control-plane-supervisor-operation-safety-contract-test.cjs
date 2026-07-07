'use strict';

const assert = require('node:assert/strict');

const {
  SUPERVISED_MODULES,
  IN_PROCESS_MODULES
} = require('../src/control-plane/module-registry.cjs');

const {
  ALLOWED_MODULES,
  MODULE_TO_SCRIPTS
} = require('../src/control-plane/floki-control-supervisor.cjs');

function sorted(values) {
  return Array.from(values).sort();
}

assert.deepEqual(
  sorted(ALLOWED_MODULES),
  sorted(SUPERVISED_MODULES),
  'supervisor allowlist must exactly match the authoritative supervised set'
);

for (const key of IN_PROCESS_MODULES) {
  assert.equal(
    ALLOWED_MODULES.includes(key),
    false,
    `${key} is in-process and must not be accepted by the supervisor`
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(MODULE_TO_SCRIPTS, key),
    false,
    `${key} is in-process and must not have supervisor scripts`
  );
}

for (const key of Object.keys(MODULE_TO_SCRIPTS)) {
  assert.equal(
    SUPERVISED_MODULES.has(key),
    true,
    `${key} has supervisor scripts but is not supervised`
  );
}

const fullRuntimeScripts = new Set([
  'floki-chat-start.sh',
  'floki-chat-stop.sh'
]);

for (const [key, operations] of Object.entries(MODULE_TO_SCRIPTS)) {
  if (key === 'floki_core') continue;

  for (const [action, script] of Object.entries(operations)) {
    assert.equal(
      fullRuntimeScripts.has(script),
      false,
      `${key}.${action} must not alias a full-runtime lifecycle script`
    );
  }
}

assert.deepEqual(
  MODULE_TO_SCRIPTS.floki_core,
  {
    start: 'floki-chat-start.sh',
    stop: 'floki-chat-stop.sh'
  },
  'Floki Core must retain the independent supervisor recovery path'
);

for (const unsafeAlias of [
  'authoritative_api',
  'hearing',
  'speech',
  'cognition',
  'memory',
  'emotion',
  'live_event_stream'
]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(MODULE_TO_SCRIPTS, unsafeAlias),
    false,
    `${unsafeAlias} must not alias whole-runtime scripts`
  );
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SUPERVISOR_OPERATION_SAFETY_CONTRACT_PASS',
  supervised_modules: sorted(SUPERVISED_MODULES),
  in_process_modules: sorted(IN_PROCESS_MODULES),
  mapped_supervisor_modules: Object.keys(MODULE_TO_SCRIPTS).sort(),
  full_runtime_script_owner: 'floki_core',
  lifecycle_actions_run: false
}, null, 2));
