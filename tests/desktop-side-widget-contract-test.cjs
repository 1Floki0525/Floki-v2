'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const widgetMain = read('apps/floki-neural-interface/electron/widget.cjs');
assert.match(widgetMain, /new BrowserWindow\(/);
assert.match(widgetMain, /setAlwaysOnTop\(true,\s*'floating'\)/);
assert.match(widgetMain, /setSkipTaskbar\(true\)/);
assert.match(widgetMain, /screen\.getPrimaryDisplay\(\)/);
assert.match(widgetMain, /widgetBounds/);
assert.match(widgetMain, /COLLAPSED_WIDTH\s*=\s*42/);
assert.match(widgetMain, /EXPANDED_WIDTH\s*=\s*430/);
assert.match(widgetMain, /floki-widget:expand/);
assert.match(widgetMain, /floki-widget:collapse/);
assert.match(widgetMain, /\/interface\/services/);
assert.match(widgetMain, /\/control\/modules\//);
assert.match(widgetMain, /FLOKI_DESKTOP_SIDE_WIDGET_READY/);
assert.doesNotMatch(widgetMain, /createWindow\(\)/, 'desktop widget must not require the main app window');

const widgetPage = read('apps/floki-neural-interface/src/pages/DesktopWidget.jsx');
for (const key of ['cognition', 'hearing', 'vision', 'speech', 'memory', 'sleep_scheduler', 'dream_engine', 'rsi']) {
  assert.match(widgetPage, new RegExp(`['"]${key}['"]`), `missing widget module ${key}`);
}
assert.match(widgetPage, /flokiAdapter\.getSystemStatus\(\)/);
assert.match(widgetPage, /flokiAdapter\.controlModule\(service\.key,\s*action\)/);
assert.match(widgetPage, /floki-desktop-widget-tab/);
assert.match(widgetPage, /floki-desktop-side-widget/);
assert.match(widgetPage, /ONLINE/);
assert.match(widgetPage, /DEGRADED/);
assert.match(widgetPage, /OFFLINE/);
assert.match(widgetPage, /LISTENING/);
assert.match(widgetPage, /SEEING/);

const app = read('apps/floki-neural-interface/src/App.jsx');
assert.match(app, /DesktopWidget/);
assert.match(app, /path="\/desktop-widget"/);

const preload = read('apps/floki-neural-interface/electron/preload.cjs');
assert.match(preload, /flokiWidget/);
assert.match(preload, /floki-widget:expand/);
assert.match(preload, /floki-widget:collapse/);

const runtime = read('bin/floki-runtime.sh');
assert.match(runtime, /floki-desktop-widget-start\.sh/);
assert.match(runtime, /floki-desktop-widget-stop\.sh/);

const start = read('bin/floki-desktop-widget-start.sh');
assert.match(start, /no_graphical_desktop/);
assert.match(start, /electron\/widget\.cjs/);
assert.match(start, /floki-desktop-widget\.pid/);
assert.match(start, /FLOKI_DESKTOP_SIDE_WIDGET_START_PASS/);

const stop = read('bin/floki-desktop-widget-stop.sh');
assert.match(stop, /floki-desktop-widget\.pid/);
assert.match(stop, /FLOKI_DESKTOP_SIDE_WIDGET_STOP_PASS/);

const pkg = JSON.parse(read('package.json'));
assert.match(pkg.scripts['test:node24'], /tests\/desktop-side-widget-contract-test\.cjs/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_DESKTOP_SIDE_WIDGET_CONTRACT_PASS',
  right_edge_widget: true,
  starts_with_runtime: true,
  modules: ['cognition', 'hearing', 'vision', 'speech', 'memory', 'sleep_scheduler', 'dream_engine', 'rsi']
}, null, 2));
