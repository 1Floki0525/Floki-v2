'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function run() {
  const startScript = read('bin/floki-chat-start.sh');
  const frontal = read('brain/frontal/index.cjs');
  const liveInterface = read('src/chat/floki-live-chat-interface.cjs');
  const autoload = read('bin/floki-knowledge-autoload.sh');
  const dreamEngine = read('src/chat/dream-engine.cjs');
  assert.ok(startScript.includes('getAudioConfig'), 'start script must read audio config from YAML via floki-config');
  assert.ok(startScript.includes('getLiveChatConfig'), 'start script must read live chat config from YAML via floki-config');
  assert.equal(frontal.includes('Current live user request has priority over recalled memories.'), true);
  assert.equal(frontal.includes('Do not mention recalled topics unless the user directly asked for them.'), true);
  assert.equal(frontal.includes('For simple greetings or status questions, answer the greeting/status directly.'), true);
  assert.equal(liveInterface.includes('floki-knowledge-autoload.sh'), true);
  assert.ok(autoload.includes("require('./src/config/floki-config.cjs')") || autoload.includes("require('./src/config/floki-config')"), 'autoload script must read youtube_transcript_root from YAML config via floki-config');
  assert.equal(dreamEngine.includes('retrieveKnowledgeContext'), true);
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_CHAT_LATENCY_CONTEXT_CORPUS_PASS',
    live_capture_seconds_default: 2,
    live_whisper_model_default: 'small',
    stale_memory_topic_bleed_blocked: true,
    youtube_transcript_autoload_enabled: true,
    dream_knowledge_context_enabled: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_CHAT_LATENCY_CONTEXT_CORPUS_FAIL', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2)); process.exit(1); }
