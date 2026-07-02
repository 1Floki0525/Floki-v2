'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const supervisorPath = path.join(
  ROOT,
  'src/control-plane/floki-control-supervisor.cjs'
);

const {
  MODULE_TO_SCRIPTS,
  MODULE_TO_STATUS_COMMAND,
  pollStatusUntil
} = require(supervisorPath);

async function run() {
  const source = fs.readFileSync(supervisorPath, 'utf8');

  assert.equal(typeof pollStatusUntil, 'function');
  assert.ok(MODULE_TO_SCRIPTS);
  assert.ok(MODULE_TO_STATUS_COMMAND);

  const mappedModules = Object.keys(MODULE_TO_SCRIPTS).sort();
  assert.deepEqual(mappedModules, [
    'floki_core',
    'rsi',
    'sleep_scheduler',
    'vision'
  ]);

  for (const moduleKey of mappedModules) {
    assert.equal(
      typeof MODULE_TO_STATUS_COMMAND[moduleKey],
      'string',
      'missing module-specific status command for ' + moduleKey
    );
    assert.ok(
      MODULE_TO_STATUS_COMMAND[moduleKey].trim(),
      'empty module-specific status command for ' + moduleKey
    );
  }

  for (const unsafeAlias of [
    'authoritative_api',
    'cognition',
    'hearing',
    'speech',
    'memory',
    'emotion',
    'live_event_stream',
    'dream_engine'
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        MODULE_TO_SCRIPTS,
        unsafeAlias
      ),
      false,
      'unsafe supervisor script mapping remains for ' + unsafeAlias
    );
  }

  let clock = 0;
  let startIndex = 0;
  const startSequence = ['stopped', 'stopped', 'running'];
  const startVerification = await pollStatusUntil(
    async () => {
      const value = startSequence[
        Math.min(startIndex, startSequence.length - 1)
      ];
      startIndex += 1;
      return value;
    },
    'running',
    100,
    10,
    {
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      }
    }
  );

  assert.equal(startVerification.verified, true);
  assert.equal(startVerification.observedStatus, 'running');
  assert.equal(startVerification.expectedStatus, 'running');
  assert.equal(startVerification.attempts, 3);

  clock = 0;
  let stopIndex = 0;
  const stopSequence = ['running', 'stopped'];
  const stopVerification = await pollStatusUntil(
    async () => {
      const value = stopSequence[
        Math.min(stopIndex, stopSequence.length - 1)
      ];
      stopIndex += 1;
      return value;
    },
    'stopped',
    100,
    10,
    {
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      }
    }
  );

  assert.equal(stopVerification.verified, true);
  assert.equal(stopVerification.observedStatus, 'stopped');
  assert.equal(stopVerification.attempts, 2);

  clock = 0;
  const timeoutVerification = await pollStatusUntil(
    async () => 'unknown',
    'running',
    20,
    10,
    {
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      }
    }
  );

  assert.equal(timeoutVerification.verified, false);
  assert.equal(timeoutVerification.observedStatus, 'unknown');
  assert.equal(timeoutVerification.expectedStatus, 'running');
  assert.equal(timeoutVerification.attempts, 3);

  const startBegin = source.indexOf(
    '  async function performStart(moduleKey) {'
  );
  const stopBegin = source.indexOf(
    '  async function performStop(moduleKey) {'
  );
  const resetBegin = source.indexOf(
    '  async function performReset(moduleKey) {'
  );

  assert.ok(startBegin >= 0);
  assert.ok(stopBegin > startBegin);
  assert.ok(resetBegin > stopBegin);

  const startBlock = source.slice(startBegin, stopBegin);
  const stopBlock = source.slice(stopBegin, resetBegin);

  assert.match(
    startBlock,
    /pollModuleStatus\(\s*moduleKey,\s*'running'/
  );
  assert.match(
    stopBlock,
    /pollModuleStatus\(\s*moduleKey,\s*'stopped'/
  );
  assert.doesNotMatch(startBlock, /pollRuntimeReady/);
  assert.doesNotMatch(stopBlock, /pollRuntimeReady/);
  assert.doesNotMatch(source, /async function pollRuntimeReady/);

  console.log(JSON.stringify({
    ok: true,
    marker:
      'FLOKI_V2_SUPERVISOR_MODULE_VERIFICATION_CONTRACT_PASS',
    mapped_modules: mappedModules,
    module_specific_status_commands:
      mappedModules.map((moduleKey) => ({
        module: moduleKey,
        status_command: MODULE_TO_STATUS_COMMAND[moduleKey]
      })),
    start_poll_verified: true,
    stop_poll_verified: true,
    timeout_honest: true,
    dream_engine_scheduler_alias_removed: true,
    lifecycle_actions_run: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker:
      'FLOKI_V2_SUPERVISOR_MODULE_VERIFICATION_CONTRACT_FAIL',
    error: error.message,
    stack: error.stack
  }, null, 2));
  process.exitCode = 1;
});
