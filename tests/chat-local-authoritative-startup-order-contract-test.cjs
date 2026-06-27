'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function assertOrdered(text, labels) {
  let previous = -1;
  for (const label of labels) {
    const current = text.indexOf(label);
    assert.notEqual(current, -1, `missing startup sequence element: ${label}`);
    assert.ok(current > previous, `startup sequence element is out of order: ${label}`);
    previous = current;
  }
}

const start = read('bin/floki-start.sh');
const chatStart = read('bin/floki-chat-start.sh');
const localStart = read('bin/floki-chat-local-start.sh');
const electron = read('apps/floki-neural-interface/electron/main.cjs');
const runtime = read('src/runtime/chat-local-runtime.cjs');

const chatLocal = start.slice(
  start.indexOf('  chat.local)'),
  start.indexOf('  text-chat)')
);

assertOrdered(chatLocal, [
  'startup_stage "1/7"',
  'startup_stage "2/7"',
  'preflight_core_brain',
  'startup_stage "3/7"',
  'start_sleep_scheduler',
  'verify_sleep_scheduler',
  'startup_stage "4/7"',
  'buildFlokiLifecycleStatus',
  'startup_stage "5/7"',
  'start_chat_hearing',
  'bash bin/floki-chat-local-start.sh'
]);

assertOrdered(localStart, [
  '[FLOKI STARTUP 6/7]',
  'npm run build',
  'npm run test:integration',
  '[FLOKI STARTUP 7/7]'
]);
const localLaunch = localStart.slice(
  localStart.lastIndexOf('echo "[FLOKI STARTUP 7/7]')
);
assertOrdered(localLaunch, [
  '[FLOKI STARTUP 7/7]',
  'run_supervised_electron'
]);
assert.match(localStart, /runtime_watchdog_poll_ms/, 'Electron handoff must use YAML runtime watchdog poll timing');
assert.match(localStart, /runtime_watchdog_request_timeout_ms/, 'Electron handoff must use YAML runtime watchdog request timeout');
assert.match(localStart, /runtime_watchdog_consecutive_failure_limit/, 'Electron handoff must use YAML consecutive watchdog failure limit');
assert.match(localStart, /\.\/node_modules\/\.bin\/electron \. &/, 'Electron must run as a supervised child process');
assert.doesNotMatch(localStart, /exec \.\/node_modules\/\.bin\/electron \./, 'Electron must not replace the launcher shell');

const readyToShow = electron.slice(
  electron.indexOf("mainWindow.once('ready-to-show'"),
  electron.indexOf('mainWindow.webContents.setWindowOpenHandler')
);

assertOrdered(readyToShow, [
  'mainWindow.show()',
  "runtimeRequest('POST', '/client-ready'"
]);

assert.match(runtime, /initial_awake: false/, 'audio must begin gated off');
assert.match(
  runtime,
  /const hearingEnabled = awake && state\.client_ready === true/,
  'hearing must require both awake time and visible interface readiness'
);
assert.match(
  runtime,
  /const visionEnabled = awake && state\.client_ready === true/,
  'vision must require both awake time and visible interface readiness'
);
assert.match(
  runtime,
  /lifecycle = buildFlokiLifecycleStatus\(\)/,
  'runtime must resolve current lifecycle from system time'
);
assert.match(runtime, /type: 'experience'/, 'ambient audio memories must use a valid memory type');
assert.match(runtime, /ambient memory rejected:/, 'ambient memory failures must expose the real failure');

assert.match(chatStart, /runtime_pids_for_project/, 'runtime launcher must find orphaned project runtimes');
assert.match(chatStart, /chat-local-runtime\.startup\.log/, 'runtime launcher must use a startup-specific log');
assert.match(chatStart, /s\.pid===Number\(process\.argv\[2\]\)/, 'runtime readiness must belong to the new PID');
assert.match(chatStart, /<\/dev\/null/, 'background runtime stdin must be detached');
assert.match(chatStart, /disown "\$STARTED_PID"/, 'background runtime must be detached from the launcher shell');

const { getSleepConfig } = require('../src/config/floki-config.cjs');
const { loadCoreBrainConfig, enabledModuleNames } = require('../brain/core_brain/index.cjs');

const sleep = getSleepConfig('chat');
assert.equal(sleep.timezone, 'America/Toronto');
assert.equal(sleep.start_hhmm, '23:00');
assert.equal(sleep.end_hhmm, '07:00');

const config = loadCoreBrainConfig('chat');
assert.deepEqual(
  enabledModuleNames(config.modules),
  [
    'thalamus',
    'temporal',
    'amygdala',
    'emotions_base',
    'hippocampus',
    'personality',
    'pineal',
    'frontal',
    'broca',
    'chat_world_senses'
  ],
  'chat brain modules must load in the authoritative order'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_AUTHORITATIVE_STARTUP_ORDER_CONTRACT_PASS',
  brain_module_order_verified: true,
  app_before_senses_verified: true,
  system_time_lifecycle_verified: true,
  timezone: sleep.timezone,
  awake_window: '07:00-23:00',
  sleep_window: '23:00-07:00',
  client_ready_gate_verified: true,
  chat_mode_only: true,
  game_mode_started: false
}, null, 2));
