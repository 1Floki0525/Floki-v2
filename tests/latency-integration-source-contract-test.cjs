'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const frontal = read('brain/frontal/index.cjs');
const broca = read('brain/broca/index.cjs');
const typed = read('src/chat/floki-live-chat-interface.cjs');
const spoken = read('src/senses/spoken-reply-once.cjs');
const config = read('config/chat.config.yaml');
const ollama = read('src/model/ollama-client.cjs');

assert.match(frontal, /required:\s*\[\s*'response_intent_for_broca'/s);
assert.match(frontal, /generateJsonStream/);
assert.match(frontal, /extractCompletedFirstPublicField/);
assert.match(frontal, /final cognition public response differs/);
assert.match(broca, /authorizePublicText/);
assert.doesNotMatch(broca, /I feel this as/);
assert.match(typed, /displayedText !== null && displayedText !== reply/);
assert.match(typed, /response_interrupted/);
assert.match(spoken, /on_public_text\(payload\) \{\s*startEarlySpoken\(payload\)/s);
assert.doesNotMatch(spoken, /on_first_safe_sentence\(payload\) \{\s*startEarlySpoken\(payload\)/s);
assert.match(ollama, /stream: input\.stream === true/);
assert.match(ollama, /createNdjsonParser/);
assert.match(config, /public_response_streaming_enabled:\s*true/);
assert.match(config, /first_sentence_tts_enabled:\s*true/);
assert.match(config, /latency_events_enabled:\s*true/);
assert.doesNotMatch(frontal + typed + spoken + ollama, /floki-qwen3\.5:4b-16k|qwen3\.5:9b/);

console.log('latency-integration-source-contract-test PASS');
