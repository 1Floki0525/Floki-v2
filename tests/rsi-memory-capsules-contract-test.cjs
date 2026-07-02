'use strict';

// Contract: memory capsules retrieve compact, task-relevant slices with personal
// continuity and engineering memory kept strictly separate and bounded by YAML.
// Exercises real production functions (no mocks).

const assert = require('node:assert/strict');

const capsules = require('../src/self-improvement/memory-capsules.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
const signals = 'investigate runtime crash and repair config transport';

const all = capsules.retrieveCapsules(signals, config);
assert.equal(all.marker, 'FLOKI_V2_RSI_MEMORY_CAPSULES');

// --- strict separation ---
assert.equal(all.personal.kind, 'personal_continuity');
assert.equal(all.engineering.kind, 'engineering_memory');
assert.ok(!('approved_candidates' in all.personal), 'personal capsule has no engineering fields');
assert.ok(!('items' in all.engineering) || Array.isArray(all.engineering.notes), 'engineering uses its own sections');

// --- personal capsule bounded ---
assert.ok(all.personal.item_count <= config.memory_capsule_max_items_per_section, 'personal items bounded');
assert.ok(all.personal.chars_used <= config.memory_capsule_total_max_chars, 'personal total bound');
for (const item of all.personal.items) {
  assert.ok(item.excerpt.length <= config.memory_capsule_item_max_chars, 'personal item char bound');
}

// SOUL.md must surface in the personal capsule (it exists in the repo)
const fs = require('node:fs');
if (fs.existsSync(require('node:path').resolve(config.project_root, 'SOUL.md'))) {
  assert.ok(all.personal.items.some((i) => i.source.includes('SOUL.md')), 'SOUL.md present in personal capsule');
}

// --- engineering capsule bounded + structured ---
assert.ok(Array.isArray(all.engineering.approved_candidates), 'engineering lists approved candidates');
assert.ok(Array.isArray(all.engineering.denial_requirements), 'engineering lists denial requirements');
assert.ok(all.engineering.notes.length <= config.memory_capsule_max_items_per_section, 'engineering notes bounded');
assert.ok(all.engineering.chars_used <= config.memory_capsule_total_max_chars, 'engineering total bound');

// --- relevance: tokens influence ordering (smoke) ---
const tokens = capsules.signalTokensFrom(signals);
assert.ok(tokens.includes('runtime') && tokens.includes('config'), 'signal tokens extracted');

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_MEMORY_CAPSULES_PASS',
  separated: true,
  personal_items: all.personal.item_count,
  engineering_notes: all.engineering.notes.length,
  bounded: true
}, null, 2));
