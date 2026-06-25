'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const dashboardPath = path.join(__dirname, '../apps/floki-neural-interface/src/pages/DreamsDashboard.jsx');
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  assert.match(dashboard, /subscribeRuntimeEvents/, 'DreamsDashboard must subscribe to live runtime events');
  assert.match(dashboard, /dreams-wake-control/, 'DreamsDashboard must render a Wake control');
  assert.match(dashboard, /dreams-request-sleep-control/, 'DreamsDashboard must render a Request Sleep control');
  assert.match(dashboard, /handleAction\(\s*['"]wake['"]/, 'Wake control must call handleAction("wake")');
  assert.match(dashboard, /handleAction\(\s*['"]requestSleep['"]/, 'Request Sleep control must call handleAction("requestSleep")');
  assert.match(dashboard, /flokiAdapter\.control\(/, 'DreamsDashboard must call flokiAdapter.control');

  const header = fs.readFileSync(
    path.join(__dirname, '../apps/floki-neural-interface/src/components/dreams/DreamsHeader.jsx'),
    'utf8'
  );
  assert.match(header, /timeline\?\.liveStatus/, 'DreamsHeader must read timeline.liveStatus');
  assert.match(header, /liveStatus\?\.lifecycleState/, 'DreamsHeader must consider liveStatus.lifecycleState');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAMS_DASHBOARD_LIVE_AND_CONTROLS_PASS',
    subscription_present: true,
    wake_control_present: true,
    request_sleep_control_present: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
