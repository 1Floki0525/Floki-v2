'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const { INTERFACE_TAB_CONTRACT, createChatLocalInterfaceApi } = require(path.join(root, 'src/runtime/chat-local-interface-api.cjs'));

const expectedTabs = ['chat', 'dreams', 'neural', 'settings', 'system'];
assert.deepEqual(Object.keys(INTERFACE_TAB_CONTRACT).sort(), expectedTabs);

const api = createChatLocalInterfaceApi({
  status: () => ({ api_ready: true, websocket_ready: true, brain_loaded: true, memory_loaded: true, ready: true, lifecycle: { is_awake: true }, hearing: {} })
});
const coverage = api.coverage();
assert.equal(coverage.backend_owners, 1);
assert.equal(coverage.mock_mode, false);
assert.equal(coverage.connected, true);

const requiredControls = ['startChat', 'stopChat', 'restartChat', 'wake', 'requestSleep', 'pauseSleep', 'resumeSleep', 'restartVision', 'restartHearing', 'restartSpeech', 'interrupt'];
const systemWrites = new Set(coverage.tabs.system.writes);
for (const control of ['restartVision', 'pauseSleep', 'resumeSleep']) assert.equal(systemWrites.has(control), true, `system backend contract missing ${control}`);
for (const tab of expectedTabs) {
  const contract = coverage.tabs[tab];
  assert.ok(contract.reads.length + contract.writes.length > 0, `${tab} has no backend operation`);
  assert.ok(contract.live_events.length > 0, `${tab} has no authoritative live event`);
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_FULL_INTERFACE_PRESERVATION_PASS',
  tabs_connected: expectedTabs.length,
  system_controls_visible: requiredControls.length,
  backend_owners: coverage.backend_owners,
  mock_mode: coverage.mock_mode,
}, null, 2));
