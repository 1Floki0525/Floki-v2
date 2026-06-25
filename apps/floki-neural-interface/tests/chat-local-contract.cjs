'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const root = path.resolve(app, '..', '..');
const { createChatLocalInterfaceApi, INTERFACE_TAB_CONTRACT } = require(path.join(root, 'src/runtime/chat-local-interface-api.cjs'));
const { upsertChatTranscriptTurn, appendPrivateThoughtRecord } = require(path.join(root, 'src/chat/chat-transcript.cjs'));

assert.equal(fs.existsSync(path.join(app, 'electron/main.cjs')), true);
assert.equal(fs.existsSync(path.join(app, 'electron/preload.cjs')), true);
assert.equal(fs.existsSync(path.join(app, 'backend/floki-local-api.cjs')), false, 'parallel local API owner must not exist');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-interface-contract-'));
try {
  const transcriptDir = path.join(temp, 'interface');
  upsertChatTranscriptTurn({ id: 'spoken-1', role: 'user', text: 'Hey Floki, what can you see?', input_modality: 'spoken', transcript_state: 'final' }, { transcript_dir: transcriptDir });
  appendPrivateThoughtRecord({ text: 'I hear the Maker asking what I can see.', category: 'hearing' }, { transcript_dir: transcriptDir });

  const api = createChatLocalInterfaceApi({
    runtime_dir: temp,
    transcript_options: { transcript_dir: transcriptDir },
    status: () => ({
      api_ready: true,
      websocket_ready: true,
      brain_loaded: true,
      memory_loaded: true,
      ready: true,
      state: 'listening',
      lifecycle: { is_awake: true },
      hearing: { service_state: 'listening', piper_ready: true, playback_ready: true }
    })
  });

  const coverage = api.coverage();
  assert.equal(coverage.connected, true);
  assert.equal(coverage.authoritative_backend, 'src/runtime/chat-local-runtime.cjs');
  assert.equal(coverage.backend_owners, 1);
  assert.equal(coverage.mock_mode, false);
  assert.deepEqual(Object.keys(coverage.tabs).sort(), ['chat', 'dreams', 'neural', 'settings', 'system']);
  assert.deepEqual(Object.keys(coverage.tabs).sort(), Object.keys(INTERFACE_TAB_CONTRACT).sort());
  for (const [tab, contract] of Object.entries(coverage.tabs)) {
    assert.ok(contract.reads.length > 0, `${tab} must read authoritative backend state`);
    assert.ok(contract.live_events.length > 0, `${tab} must declare live backend events`);
  }

  const transcript = api.getTranscript(20);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, 'Hey Floki, what can you see?');
  assert.equal(transcript[0].isPartial, false);
  const neural = api.buildNeuralEvents(20);
  assert.equal(neural.length, 1);
  assert.equal(neural[0].summary, 'I hear the Maker asking what I can see.');
  assert.equal(/^I\b/.test(neural[0].summary), true);
  assert.equal(api.getSettings().connection.mockMode, false);

  const services = api.buildServices();
  assert.equal(Array.isArray(services), true);
  assert.equal(services.some((service) => service.name === 'Authoritative API'), true);
  assert.equal(services.some((service) => /Minecraft|Unreal|Local API/i.test(service.name)), false);

  console.log('FLOKI_V2_CHAT_LOCAL_CONTRACT_PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
