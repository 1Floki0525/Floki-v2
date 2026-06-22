'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');
const {
  appendChatTranscriptTurn,
  appendPrivateThoughtRecord,
  readChatTranscriptTail,
  readPrivateThoughtTail,
  clearChatTranscript
} = require('../src/chat/chat-transcript.cjs');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-transcript-contract-'));
  try {
    appendChatTranscriptTurn({ role: 'user', text: 'typed continuity', input_modality: 'text' }, { transcript_dir: temp });
    appendChatTranscriptTurn({ role: 'user', text: 'spoken continuity', input_modality: 'spoken' }, { transcript_dir: temp });
    appendPrivateThoughtRecord({ text: 'private record remains', source: 'contract' }, { transcript_dir: temp });

    const before = readChatTranscriptTail(20, { transcript_dir: temp });
    assert.equal(before.length, 2);
    assert.deepEqual(before.map((entry) => entry.input_modality), ['text', 'spoken']);

    const cleared = clearChatTranscript({ transcript_dir: temp });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.entries_cleared, 2);
    assert.equal(cleared.private_thoughts_preserved, true);
    assert.deepEqual(readChatTranscriptTail(20, { transcript_dir: temp }), []);
    assert.equal(readPrivateThoughtTail(20, { transcript_dir: temp }).length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const runtime = read('src/runtime/chat-local-runtime.cjs');
  const audio = read('src/senses/live-audio-service.cjs');
  const electron = read('apps/floki-neural-interface/electron/main.cjs');
  const preload = read('apps/floki-neural-interface/electron/preload.cjs');
  const adapter = read('apps/floki-neural-interface/src/integrations/floki/adapter.js');
  const panel = read('apps/floki-neural-interface/src/components/chat/ChatPanel.jsx');
  const readme = read('README.md');
  const config = read('config/chat.config.yaml');

  assert.match(runtime, /initial_awake: false/);
  assert.match(runtime, /url\.pathname === '\/client-ready'/);
  assert.match(runtime, /url\.pathname === '\/client-detached'/);
  assert.match(runtime, /url\.pathname === '\/transcript\/clear'/);
  assert.match(runtime, /await liveAudio\.setAwake\(hearingEnabled\)/);
  assert.match(runtime, /const visionEnabled = awake && state\.client_ready === true/);
  assert.match(runtime, /if \(!visionEnabled\)/);
  assert.match(runtime, /state\.client_ready !== true\s*\? 'awaiting_client'/);

  assert.match(electron, /mainWindow\.show\(\);\s*void runtimeRequest\('POST', '\/client-ready'/s);
  assert.match(electron, /'floki:clear-transcript'/);
  assert.match(preload, /clearTranscript/);
  assert.match(adapter, /clearTranscript/);
  assert.match(panel, /getTranscript\(500\)/);
  assert.match(panel, /Clear chat/);
  assert.doesNotMatch(panel, /const spoken = transcript\.filter/);

  assert.doesNotMatch(audio, /stable_count >= 2/);
  assert.match(audio, /attentionCandidate\.last_changed_at/);
  assert.match(audio, /attention_followup_interval_ms/);
  assert.match(config, /attention_followup_interval_ms:/);

  assert.match(readme, /personal AI companion and digital-being project/i);
  assert.match(readme, /chat\.local.*personal AI companion/is);
  assert.match(readme, /game.*AI friend for games/is);
  assert.doesNotMatch(readme, /Stage 00 - Scaffold Only/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_INTERFACE_LIFECYCLE_TRANSCRIPT_PASS',
    complete_spoken_command_settle: true,
    external_senses_wait_for_visible_interface: true,
    typed_and_spoken_history_restored: true,
    visible_chat_clear_supported: true,
    private_memory_preserved_on_clear: true,
    readme_describes_real_project: true,
    node_version: process.version
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_LOCAL_INTERFACE_LIFECYCLE_TRANSCRIPT_FAIL',
    error: error.stack || error.message
  }, null, 2));
  process.exit(1);
}
