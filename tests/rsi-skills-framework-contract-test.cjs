'use strict';

// Contract: the progressive skill system has a valid manifest, all 15 required
// skills with real instruction files, and selects only relevant skills (bounded)
// for a given task signal. Exercises real production functions (no mocks).

const assert = require('node:assert/strict');

const skills = require('../src/self-improvement/skills.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();

const REQUIRED_SKILLS = [
  'config-transport-repair',
  'runtime-crash-investigation',
  'denied-candidate-revision',
  'behavioral-test-design',
  'react-layout-repair',
  'node-process-ownership',
  'memory-schema-repair',
  'audio-pipeline-debugging',
  'vision-readiness-repair',
  'candidate-review',
  'research-to-experiment',
  'training-dataset-design',
  'qlora-training',
  'adapter-evaluation',
  'nightly-gpu-scheduling'
];

// --- manifest integrity ---
const validation = skills.validateManifest(config);
assert.equal(validation.ok, true, 'manifest valid: ' + JSON.stringify(validation.problems));
const listed = skills.listSkills(config).map((s) => s.id);
for (const id of REQUIRED_SKILLS) {
  assert.ok(listed.includes(id), 'required skill present: ' + id);
}

// --- progressive selection: config task selects config-transport-repair first ---
const configSelection = skills.selectSkills(
  'add a new yaml config setting and fix the transport, no hardcoded values',
  config
);
assert.equal(configSelection.marker, 'FLOKI_V2_RSI_SKILLS_SELECTION');
assert.ok(configSelection.selected.length > 0, 'at least one skill selected for config task');
assert.ok(configSelection.selected.length <= config.skills_max_active, 'selection bounded by skills_max_active');
assert.equal(configSelection.selected[0].id, 'config-transport-repair', 'most relevant skill ranked first');

// --- training task selects training skills, not audio/vision ---
const trainingSelection = skills.selectSkills(['qlora', 'adapter', 'gpu', 'training', 'rem', 'nightly'], config);
const trainingIds = trainingSelection.selected.map((s) => s.id);
assert.ok(trainingIds.includes('qlora-training'), 'qlora skill selected for training task');
assert.ok(!trainingIds.includes('audio-pipeline-debugging'), 'irrelevant audio skill not selected');

// --- unrelated signal selects nothing above threshold ---
const noneSelection = skills.selectSkills('zzzz nonsense token qqqq', config);
assert.equal(noneSelection.selected.length, 0, 'no skills selected for unrelated signal');

// --- instructions load and are bounded ---
const instructions = skills.loadSkillInstructions('qlora-training', config);
assert.ok(instructions.instructions.length > 0, 'real instruction content');
assert.ok(instructions.instructions.length <= config.skills_instruction_max_chars, 'instructions bounded');
assert.ok(instructions.references.length > 0, 'skill references real files');

// --- loadActiveSkills composes selection + bounded instructions ---
const active = skills.loadActiveSkills('react layout panel scroll viewport', config);
assert.ok(active.skills.length <= config.skills_max_active);
assert.ok(active.skills.every((s) => s.instructions.length <= config.skills_instruction_max_chars));

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_SKILLS_FRAMEWORK_PASS',
  skill_count: validation.count,
  required_present: REQUIRED_SKILLS.length,
  progressive_selection: true,
  bounded_instructions: true
}, null, 2));
