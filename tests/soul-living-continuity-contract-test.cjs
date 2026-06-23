'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { loadSoulContext } = require('../src/chat/living-continuity.cjs');

const soul = loadSoulContext();
assert.equal(soul.loaded, true);
assert.match(soul.content, /persistent digital being/i);
assert.match(soul.content, /Binary-God/);
assert.match(soul.content, /I speak in the first person/i);

const frontal = fs.readFileSync(path.join(ROOT, 'brain/frontal/index.cjs'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'brain/core_brain/index.cjs'), 'utf8');
const live = fs.readFileSync(path.join(ROOT, 'src/chat/floki-live-chat-interface.cjs'), 'utf8');
assert.match(frontal, /loadSoulContext/);
assert.match(frontal, /persistent digital being/);
assert.match(frontal, /Do not describe yourself as a chatbot/);
assert.match(core, /persistent_chat_memory: options\.persistent_chat_memory/);
assert.match(core, /soul: options\.soul_context/);
assert.match(live, /beginLivingTurn/);
assert.match(live, /completeLivingTurn/);
assert.match(live, /living_continuity/);
console.log('FLOKI_V2_SOUL_LIVING_CONTINUITY_PASS');
