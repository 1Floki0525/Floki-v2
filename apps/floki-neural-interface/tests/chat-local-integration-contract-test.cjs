'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const { createChatLocalInterfaceApi } = require(path.join(root, 'src/runtime/chat-local-interface-api.cjs'));
const { upsertChatTranscriptTurn, appendPrivateThoughtRecord } = require(path.join(root, 'src/chat/chat-transcript.cjs'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-authoritative-interface-integration-'));
try {
  const transcriptDir = path.join(temp, 'interface');
  upsertChatTranscriptTurn({ id: 'speech-live', role: 'user', text: 'Hey Floki, what can you see?', input_modality: 'spoken', transcript_state: 'partial' }, { transcript_dir: transcriptDir });
  upsertChatTranscriptTurn({ id: 'speech-live', role: 'user', text: 'Hey Floki, what can you see?', input_modality: 'spoken', transcript_state: 'final' }, { transcript_dir: transcriptDir });
  appendPrivateThoughtRecord({ text: 'I am focusing on describing what I see clearly.', category: 'attention' }, { transcript_dir: transcriptDir });

  const api = createChatLocalInterfaceApi({
    runtime_dir: temp,
    transcript_options: { transcript_dir: transcriptDir },
    status: () => ({ api_ready: true, websocket_ready: true, brain_loaded: true, memory_loaded: true, ready: true, state: 'listening', lifecycle: { is_awake: true }, hearing: { service_state: 'listening' } })
  });

  const transcript = api.getTranscript(50);
  assert.equal(transcript.length, 1, 'partial and final must converge to one visible row');
  assert.equal(transcript[0].isPartial, false);
  assert.equal(transcript[0].content, 'Hey Floki, what can you see?');

  const neural = api.buildNeuralEvents(50);
  assert.equal(neural.length, 1);
  assert.match(neural[0].summary, /^I\b/);
  assert.doesNotMatch(neural[0].summary, /payload|trace id|process id|transport|marker|file path|\{\s*"/i);

  const coverage = api.coverage();
  assert.equal(coverage.backend_owners, 1);
  assert.equal(coverage.mock_mode, false);
  assert.deepEqual(Object.keys(coverage.tabs).sort(), ['chat', 'dreams', 'neural', 'settings', 'system']);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_INTEGRATION_PASS',
    authoritative_backend: coverage.authoritative_backend,
    tabs_connected: Object.keys(coverage.tabs).length,
    transcript_upserted: true,
    neural_stream_natural: true,
    node: process.version
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
