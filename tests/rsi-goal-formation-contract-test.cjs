'use strict';

// Contract: autonomous goal formation records full provenance per goal, enforces
// the proposal count bounds, supports Floki's selection and Maker override, and
// the controller may reject ONLY for the enumerated reasons. Real functions.

const assert = require('node:assert/strict');

const gf = require('../src/self-improvement/goal-formation.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();

function validGoalInput(overrides = {}) {
  return Object.assign({
    desire: 'Improve my tool-selection accuracy when investigating runtime crashes',
    objective: 'Add a focused heuristic so the investigator role prefers find_callers before broad search',
    personal_reason: 'I keep wasting turns searching broadly; I want to feel more competent and deliberate',
    originating_experiences: ['cycle-12 wasted 6 search turns', 'Maker noted I repeat searches'],
    belief_value_relevance: 'Values: competence, honesty about my limits',
    runtime_or_source_evidence: 'audit.jsonl shows repeated_tool_signature on search in 3 recent runs',
    expected_capability_change: 'Fewer wasted investigation turns; faster correct localization',
    novelty: 'medium',
    personal_relevance: 'high',
    technical_value: 'high',
    feasibility: 'high',
    risk: 'low',
    measurable_success_criteria: ['investigation reaches target file in <= 4 tool calls in a focused test']
  }, overrides);
}

// --- goal record requires full provenance ---
const goal = gf.createGoalRecord(validGoalInput(), config);
for (const field of gf.REQUIRED_GOAL_FIELDS) {
  assert.ok(goal[field] !== undefined && goal[field] !== null, 'goal records field: ' + field);
}
assert.ok(goal.goal_id.startsWith(config.goal_id_prefix), 'goal id prefixed from YAML');
assert.equal(goal.source, 'floki_selected');

// missing required field is rejected
assert.throws(() => gf.createGoalRecord(validGoalInput({ measurable_success_criteria: '' }), config), /missing required fields/);
assert.throws(() => gf.createGoalRecord(validGoalInput({ originating_experiences: [] }), config), /missing required fields/);

// --- proposal set bounds (min/max from YAML) ---
const proposals = [];
for (let i = 0; i < config.goal_min_proposals; i += 1) {
  proposals.push(gf.createGoalRecord(validGoalInput({ goal_id: 'goal-test-' + i }), config));
}
gf.validateGoalSet(proposals, config);
assert.throws(() => gf.validateGoalSet(proposals.slice(0, config.goal_min_proposals - 1), config), /too few/);
const tooMany = [];
for (let i = 0; i < config.goal_max_proposals + 1; i += 1) tooMany.push(gf.createGoalRecord(validGoalInput({ goal_id: 'goal-x-' + i }), config));
assert.throws(() => gf.validateGoalSet(tooMany, config), /too many/);

// --- Floki selects; Maker override resolution ---
const selected = gf.selectGoal(proposals, proposals[1].goal_id);
assert.equal(selected.goal_id, proposals[1].goal_id);

const free = gf.resolveObjective('');
assert.equal(free.source, 'floki_selected');
assert.equal(free.floki_free_selection, true);
const maker = gf.resolveObjective('Fix the webcam readiness race');
assert.equal(maker.source, 'maker_requested');
assert.equal(maker.floki_free_selection, false);

// --- controller review: accepts a sound goal ---
const accept = gf.controllerReview(goal, {
  protected_path_prefixes: ['state/', 'secrets/', '.git/'],
  active_or_queued_objectives: [],
  compare_to_denial: () => ({ is_unchanged_duplicate: false })
}, config);
assert.equal(accept.accepted, true, 'sound goal accepted');

// --- controller rejects ONLY for enumerated reasons ---
const unsafe = gf.controllerReview(gf.createGoalRecord(validGoalInput({ risk: 'unacceptable' }), config), {}, config);
assert.equal(unsafe.rejection_reason, 'unsafe');

const protectedTarget = gf.controllerReview(
  gf.createGoalRecord(validGoalInput({ target_paths: ['state/floki/secret.json'] }), config),
  { protected_path_prefixes: ['state/'] },
  config
);
assert.equal(protectedTarget.rejection_reason, 'unsafe');

const noVerify = gf.createGoalRecord(validGoalInput(), config);
const noVerifyMut = Object.assign({}, noVerify, { measurable_success_criteria: [] });
assert.equal(gf.controllerReview(noVerifyMut, {}, config).rejection_reason, 'impossible_to_verify');

const hostGoal = gf.createGoalRecord(validGoalInput({ requires_host_access: true }), config);
assert.equal(gf.controllerReview(hostGoal, {}, config).rejection_reason, 'outside_sandbox_authority');

const dupDenied = gf.controllerReview(goal, {
  compare_to_denial: () => ({ is_unchanged_duplicate: true })
}, config);
assert.equal(dupDenied.rejection_reason, 'unchanged_duplicate_of_denied');

const activeDup = gf.controllerReview(goal, {
  active_or_queued_objectives: [goal.objective]
}, config);
assert.equal(activeDup.rejection_reason, 'already_active_or_queued');

// every rejection reason used above belongs to the closed vocabulary
for (const r of [unsafe, protectedTarget, dupDenied, activeDup]) {
  assert.ok(gf.REJECTION_REASONS.includes(r.rejection_reason), 'reason in closed set: ' + r.rejection_reason);
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_GOAL_FORMATION_PASS',
  required_fields: gf.REQUIRED_GOAL_FIELDS.length,
  rejection_reasons: gf.REJECTION_REASONS.length,
  maker_override: true,
  floki_free_selection: true
}, null, 2));
