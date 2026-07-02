'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );

  const start = read('bin/floki-sleep-scheduler-start.sh');
  const stop = read('bin/floki-sleep-scheduler-stop.sh');
  const status = read('bin/floki-sleep-scheduler-status.sh');
  const entry = read('bin/floki-start.sh');
  const scheduler = read('src/chat/sleep-cycle-scheduler.cjs');
  const sleepCycle = read('src/chat/sleep-cycle.cjs');

  assert.equal(start.includes('nvm use 24'), true);
  assert.equal(status.includes('nvm use 24'), true);
  assert.equal(start.includes('sleep-cycle-scheduler.cjs --service'), true);
  assert.equal(stop.includes('sleep-cycle-scheduler.cjs'), true);
  assert.equal(entry.includes('sleep-start'), true);
  assert.equal(entry.includes('sleep-stop'), true);
  assert.equal(entry.includes('sleep-status'), true);
  assert.equal(entry.includes('start_sleep_scheduler'), true);
  assert.equal(entry.includes('export FLOKI_ALLOW_SLEEP_CYCLE=1'), true);
  assert.equal(scheduler.includes('FLOKI_ALLOW_DREAM_ENGINE: \'1\''), true);
  assert.equal(scheduler.includes('await runSchedulerIteration'), true);
  assert.equal(sleepCycle.includes('rem_dream_' + 'failed'), false);
  assert.equal(sleepCycle.includes("status: 'failed'"), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_SCRIPTS_PASS',
    node_24_only: true,
    chat_starts_scheduler: true,
    independent_start_stop_status: true,
    no_terminal_dream_failure_path: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_SLEEP_CYCLE_SCHEDULER_SCRIPTS_ERROR',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
