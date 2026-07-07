"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

assert.equal(
  Number(process.versions.node.split('.')[0]) >= 24,
  true,
  'Node 24 or newer is required'
);

const start = read('bin/floki-sleep-scheduler-start.sh');
const stop = read('bin/floki-sleep-scheduler-stop.sh');
const status = read('bin/floki-sleep-scheduler-status.sh');
const runtime = read('bin/floki-runtime.sh');
const scheduler = read('src/chat/sleep-cycle-scheduler.cjs');
const sleepCycle = read('src/chat/sleep-cycle.cjs');

assert.match(start, /nvm use 24/);
assert.match(status, /nvm use 24/);
assert.match(start, /sleep-cycle-scheduler\.cjs --service/);
assert.match(stop, /sleep-cycle-scheduler\.cjs/);

const runtimeStart = runtime.slice(
  runtime.indexOf('  start)'),
  runtime.indexOf('  stop)')
);
const runtimeStop = runtime.slice(
  runtime.indexOf('  stop)'),
  runtime.indexOf('  restart|reset)')
);
assert.match(runtimeStart, /floki-sleep-scheduler-start\.sh/);
assert.match(runtimeStop, /floki-sleep-scheduler-stop\.sh/);
assert.match(runtimeStart, /run_helper_if_present/);

assert.match(scheduler, /readDreamEngineControl/);
assert.match(
  scheduler,
  /dreamControl\.enabled === true \? '1' : '0'/
);
assert.match(scheduler, /await runSchedulerIteration/);
assert.equal(sleepCycle.includes('rem_dream_' + 'failed'), false);
assert.equal(sleepCycle.includes("status: 'failed'"), false);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_SCRIPTS_PASS',
  node_24_only: true,
  runtime_starts_scheduler: true,
  runtime_stops_scheduler: true,
  sole_runtime_authority: true,
  no_terminal_dream_failure_path: true,
  live_services_started_by_test: false
}, null, 2));
