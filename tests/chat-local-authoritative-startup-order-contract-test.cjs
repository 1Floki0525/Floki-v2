"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

function assertOrdered(text, labels) {
  let previous = -1;
  for (const label of labels) {
    const current = text.indexOf(label);
    assert.notEqual(
      current,
      -1,
      `missing startup sequence element: ${label}`
    );
    assert.ok(
      current > previous,
      `startup sequence element is out of order: ${label}`
    );
    previous = current;
  }
}

const runtimeCommand = read('bin/floki-runtime.sh');
const app = read('bin/floki-app.sh');
const chatStart = read('bin/floki-chat-start.sh');
const localStart = read('bin/floki-chat-local-start.sh');
const electron = read(
  'apps/floki-neural-interface/electron/main.cjs'
);
const runtime = read('src/runtime/chat-local-runtime.cjs');

const runtimeStart = runtimeCommand.slice(
  runtimeCommand.indexOf('  start)'),
  runtimeCommand.indexOf('  stop)')
);
assertOrdered(runtimeStart, [
  'if ! runtime_ready; then',
  'start_runtime_owner',
  'wait_for_runtime || fail "runtime did not become ready within the configured timeout"',
  'floki-sleep-scheduler-start.sh',
  'floki-self-improvement-start.sh',
  'runtime_ready || fail "runtime is not ready after startup"'
]);

assertOrdered(app, [
  'runtime_ready || fail',
  'setsid bash -c'
]);
assert.match(app, /runtime_autostart=false/);
assert.match(app, /APP_READY_FILE/);
assert.match(app, /APP_LOG_FILE/);
assert.match(app, /terminal_released=true/);
assert.match(app, /<\/dev\/null >>"\$APP_LOG_FILE" 2>&1 &/);
assert.doesNotMatch(
  app,
  /\bwait "\$APP_PID"/,
  'floki-app.sh must release the launching terminal after window readiness'
);
assert.match(electron, /FLOKI_APP_READY_FILE/);
assert.match(electron, /writeAppReadyMarker/);
assert.match(electron, /FLOKI_V2_ELECTRON_WINDOW_READY/);

// Floki desktop identity and icon contract.
assert.match(
  electron,
  /const APP_ICON = path\.join\([\s\S]*'apps',[\s\S]*'assets',[\s\S]*'floki-icon\.png'/
);
assert.match(electron, /app\.setName\('Floki'\)/);
assert.match(electron, /app\.setDesktopName\('floki\.app\.desktop'\)/);
assert.match(electron, /icon:\s*APP_ICON/);
assert.match(electron, /mainWindow\.setIcon\(APP_ICON\)/);
assert.doesNotMatch(
  app,
  /^\s*(?:exec\s+)?(?:bash\s+)?(?:"?\$ROOT\/bin\/floki-runtime\.sh"?|(?:\.\/)?bin\/floki-runtime\.sh)\s+start\b/m,
  'floki.app must not execute the shared runtime start command'
);

assertOrdered(localStart, [
  '[FLOKI STARTUP 6/7]',
  'npm run build',
  'npm run test:integration',
  '[FLOKI STARTUP 7/7]'
]);

const finalStartupMarker = localStart.lastIndexOf(
  'echo "[FLOKI STARTUP 7/7]'
);
assert.ok(
  finalStartupMarker >= 0,
  'the final Electron launch marker must exist'
);
const localLaunch = localStart.slice(finalStartupMarker);
assertOrdered(localLaunch, [
  '[FLOKI STARTUP 7/7]',
  'run_supervised_electron'
]);

const supervisorDefinition = localStart.indexOf(
  'run_supervised_electron()'
);
const supervisorLaunchCall = localStart.lastIndexOf(
  'run_supervised_electron'
);
assert.ok(
  supervisorDefinition >= 0,
  'run_supervised_electron must be defined'
);
assert.ok(
  supervisorLaunchCall > supervisorDefinition,
  'the final startup section must invoke the supervisor after its definition'
);

assert.match(localStart, /runtime_watchdog_poll_ms/);
assert.match(localStart, /runtime_watchdog_request_timeout_ms/);
assert.match(
  localStart,
  /runtime_watchdog_consecutive_failure_limit/
);
assert.match(
  localStart,
  /\.\/node_modules\/\.bin\/electron \. &/
);
assert.doesNotMatch(
  localStart,
  /exec \.\/node_modules\/\.bin\/electron \./
);

const readyToShow = electron.slice(
  electron.indexOf("mainWindow.once('ready-to-show'"),
  electron.indexOf(
    'mainWindow.webContents.setWindowOpenHandler'
  )
);
assertOrdered(readyToShow, [
  'mainWindow.show()',
  'writeAppReadyMarker(mainWindow)',
  "runtimeRequest('POST', '/client-ready'"
]);

assert.match(runtime, /initial_awake: false/);
assert.match(
  runtime,
  /const hearingEnabled = state\.hearing_enabled === true && awake && voice\.microphoneEnabled === true/
);
assert.match(runtime, /const visionEnabled = awake && allGatesPass/);
assert.match(
  runtime,
  /filter\(\(gate\) => gate !== 'client_ready' && gate !== 'window_visible'\)/
);
assert.match(runtime, /lifecycle = readLifecycleStatus\(\)/);
assert.match(runtime, /type: 'experience'/);
assert.match(runtime, /ambient memory rejected:/);

assert.match(chatStart, /runtime_pids_for_project/);
assert.match(chatStart, /chat-local-runtime\.startup\.log/);
assert.match(
  chatStart,
  /s\.pid===Number\(process\.argv\[2\]\)/
);
assert.match(chatStart, /<\/dev\/null/);
assert.match(chatStart, /disown "\$STARTED_PID"/);

const { getSleepConfig } =
  require('../src/config/floki-config.cjs');
const {
  loadCoreBrainConfig,
  enabledModuleNames
} = require('../brain/core_brain/index.cjs');

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
  ]
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_AUTHORITATIVE_STARTUP_ORDER_CONTRACT_PASS',
  sole_runtime_authority: 'bin/floki-runtime.sh',
  runtime_before_clients_verified: true,
  app_client_only_verified: true,
  brain_module_order_verified: true,
  timezone: sleep.timezone,
  awake_window: '07:00-23:00',
  sleep_window: '23:00-07:00',
  live_services_started_by_test: false
}, null, 2));
