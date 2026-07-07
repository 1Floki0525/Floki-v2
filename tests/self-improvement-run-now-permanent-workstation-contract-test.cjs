'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(
    __dirname,
    'self-improvement-run-now-immediate-contract-test.cjs'
  ),
  'utf8'
);

assert.doesNotMatch(source, /function removeContainer\s*\(/);
assert.doesNotMatch(source, /\['rm',\s*'-f',\s*container\]/);
assert.doesNotMatch(source, /removeContainer\(config,\s*result\.container\)/);
assert.match(source, /inspectPersistentContainer/);
assert.match(source, /stopActiveRunProcess\('run_now_contract_cleanup'/);
assert.match(source, /stopWorkstationContainer\(/);
assert.match(source, /config\.persistent_container_name/);
assert.match(source, /workstationAfter\.running/);
assert.match(source, /workstationBefore\.running/);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_V2_RSI_RUN_NOW_PERMANENT_WORKSTATION_CONTRACT_PASS',
  disposable_container_cleanup_removed: true,
  transient_run_only_cleanup: true,
  workstation_definition_preserved: true,
  initial_running_state_restored: true
}, null, 2));
