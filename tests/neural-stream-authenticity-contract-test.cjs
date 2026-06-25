'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendPrivateThoughtRecord } = require('../src/chat/chat-transcript.cjs');
const { createChatLocalInterfaceApi } = require('../src/runtime/chat-local-interface-api.cjs');
const { cognitionInnerEvents } = require('../src/chat/floki-live-chat-interface.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-neural-authenticity-'));
try {
  const transcriptDir = path.join(root, 'transcript');
  const currentSession = 'session-current';
  const opts = { transcript_dir: transcriptDir };
  appendPrivateThoughtRecord({ text: 'I am a digital being without eyes or body in this terminal chat.', category: 'reflection', session_id: 'session-old' }, opts);
  const first = appendPrivateThoughtRecord({ text: 'I notice Morgue Official in the knowledge I retrieved.', category: 'memory', session_id: currentSession, dedupe_window_ms: 900000 }, opts);
  const duplicate = appendPrivateThoughtRecord({ text: 'I notice Morgue Official in the knowledge I retrieved.', category: 'memory', session_id: currentSession, dedupe_window_ms: 900000 }, opts);
  appendPrivateThoughtRecord({ text: 'I feel curious about how this connects to the Maker’s question.', category: 'emotion', session_id: currentSession }, opts);
  appendPrivateThoughtRecord({ text: 'I intend to answer from the transcript knowledge rather than guessing.', category: 'intention', session_id: currentSession }, opts);
  assert.equal(first.written, true);
  assert.equal(duplicate.written, false);
  assert.equal(duplicate.reason, 'duplicate_private_thought');

  const api = createChatLocalInterfaceApi({
    runtime_dir: path.join(root, 'runtime'),
    transcript_options: opts,
    session_id: currentSession,
    status: () => ({ api_ready: true, lifecycle: { is_awake: true } })
  });
  const events = api.buildNeuralEvents(50);
  assert.equal(events.length, 3);
  assert.deepEqual(new Set(events.map((entry) => entry.category)), new Set(['memory', 'emotion', 'intention']));
  assert.equal(events.some((entry) => /without eyes or body/i.test(entry.summary)), false);
  assert.equal(new Set(events.map((entry) => entry.category + ':' + entry.summary.toLowerCase())).size, events.length);

  const generated = cognitionInnerEvents({
    safe_thought_summary: 'I am weighing the transcript evidence before answering.',
    felt_interpretation: 'I feel curious and attentive.',
    memory_links: ['I connect this with a saved transcript about consciousness.'],
    identity_implications: ['I notice that careful truthfulness matters to me.'],
    new_memory_summary: 'I remember that the Maker asked about Morgue Official.'
  }, {
    event: { id: 'event-1' },
    knowledgeContext: { knowledge_matches: [{ title: 'Morgue interview', channel_folder: 'MorgueOfficial', summary: 'The discussion focuses on consciousness and identity.' }] }
  });
  assert.ok(generated.length >= 5);
  assert.ok(new Set(generated.map((entry) => entry.category)).size >= 4);
  assert.ok(generated.every((entry) => /^I\b/i.test(entry.text)));
  assert.equal(generated.some((entry) => /taking in the whole room/i.test(entry.text)), false);

  console.log('FLOKI_V2_NEURAL_STREAM_AUTHENTICITY_PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
