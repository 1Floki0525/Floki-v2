'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { getSelfImprovementConfig } =
  require('../src/config/floki-config.cjs');
const { createConvergencePolicy } =
  require('../src/self-improvement/convergence-policy.cjs');

const config = getSelfImprovementConfig('chat');

const experiment = () => ({
  objective: 'Test discovery-before-selection behavioral boundary',
  hypothesis: 'Allowing pre-selection discovery enables evidence-backed experiment choice',
  baseline_evidence: 'Current source lacks a test that proves this contract holds',
  target_files: ['src/self-improvement/convergence-policy.cjs'],
  success_metric: 'pre_selection_mutation_blocked reason returned for mutation tools',
  focused_test: 'node tests/self-improvement-discovery-before-selection-contract-test.cjs',
  expected_follow_on_value: 'Floki can investigate before committing to an experiment'
});

// ── 1. Pre-selection tool gates ───────────────────────────────────────────────

const gatePolicy = createConvergencePolicy(config);
gatePolicy.beginIteration(1);

// Read-only discovery tools must be allowed before selection
for (const [name, args] of [
  ['read_file', { path: 'src/self-improvement/convergence-policy.cjs' }],
  ['get_task_state', {}],
  ['get_self_context', {}],
  ['search_self_memory', { query: 'RSI' }],
  ['list_repository', {}],
  ['search_source', { query: 'select_experiment' }],
  ['inspect_symbol', { symbol: 'convergencePolicy' }]
]) {
  const result = gatePolicy.authorize(name, args);
  assert.equal(result.ok, true,
    `${name} must be allowed before selection — Floki must investigate first`);
}

// Mutation tools must be blocked before selection
for (const [name, args] of [
  ['write_file', { path: 'x', content: 'y' }],
  ['apply_patch', { patch: 'diff' }],
  ['run_verification', {}],
  ['run_focused_test', { command: 'node tests/x.cjs' }]
]) {
  const result = gatePolicy.authorize(name, args);
  assert.equal(result.ok, false,
    `${name} must be blocked before selection`);
  assert.equal(result.reason, 'pre_selection_mutation_blocked',
    `${name} block must use pre_selection_mutation_blocked reason`);
}

// Contract updated 2026-07-04: select_experiment is native but evidence-gated.
// Before the controller-owned evidence readiness categories are satisfied it
// is refused with a precise recoverable reason, and it opens as soon as
// readiness is proven with real recorded evidence.
const preEvidenceSelect = gatePolicy.authorize('select_experiment', {});
assert.equal(preEvidenceSelect.ok, false,
  'select_experiment must wait for controller-owned evidence readiness');
assert.equal(preEvidenceSelect.reason, 'selection_evidence_not_ready');
gatePolicy.record('get_task_state', {}, { ok: true });
gatePolicy.record('get_self_context', {}, { ok: true });
gatePolicy.record('search_source', { query: 'select_experiment' }, { ok: true });
gatePolicy.record(
  'read_file',
  { path: 'src/self-improvement/convergence-policy.cjs' },
  { ok: true, content: 'function createConvergencePolicy() {}' }
);
const selectResult = gatePolicy.authorize('select_experiment', {});
assert.equal(selectResult.ok, true,
  'select_experiment must open once evidence readiness is satisfied');

// ── 2. Selection rejection recovery ──────────────────────────────────────────

const recoveryEvents = [];
const recoveryPolicyWithEvents = createConvergencePolicy(
  config,
  (type, detail) => recoveryEvents.push({ type, detail })
);
recoveryPolicyWithEvents.beginIteration(1);

// First attempt: submit invalid selection (empty target_files throws)
let firstSelectionThrew = false;
try {
  recoveryPolicyWithEvents.selectExperiment({
    objective: 'Test recovery',
    hypothesis: 'A corrected selection must succeed after a rejection',
    baseline_evidence: 'First attempt had no target files',
    target_files: [],
    success_metric: 'Valid selection accepted on second attempt',
    focused_test: 'node tests/self-improvement-discovery-before-selection-contract-test.cjs',
    expected_follow_on_value: 'Selection recovery proves healthy cycle behavior'
  });
} catch (_err) {
  firstSelectionThrew = true;
}
assert.ok(firstSelectionThrew, 'selection with empty target_files must throw a validation error');
assert.equal(recoveryPolicyWithEvents.snapshot().selected_experiment, null,
  'selected_experiment must remain null after a rejected selection');

// Cycle must NOT be terminated after one rejection
const stopAfterReject = recoveryPolicyWithEvents.endIteration();
assert.equal(stopAfterReject, null,
  'convergence must not stop the cycle after a single select_experiment rejection');

// Model can still call read-only tools after rejection
const readAfterReject = recoveryPolicyWithEvents.authorize('read_file', {
  path: 'src/self-improvement/convergence-policy.cjs'
});
assert.equal(readAfterReject.ok, true,
  'read_file must remain available after a rejected selection attempt');

// Second attempt: valid selection must succeed
const validSelect = recoveryPolicyWithEvents.selectExperiment(experiment());
assert.equal(validSelect.ok, true,
  'a corrected selection must succeed after a rejected attempt');
assert.ok(recoveryPolicyWithEvents.snapshot().selected_experiment,
  'selected_experiment must be set after corrected selection');

// ── 3. Convergence budget — healthy discovery is not prematurely terminated ──

const budgetPolicy = createConvergencePolicy(config);

// Simulate discovery iterations 1-7 without selecting
for (let i = 1; i <= 7; i += 1) {
  budgetPolicy.beginIteration(i);
  budgetPolicy.authorize('read_file', { path: 'src/self-improvement/convergence-policy.cjs' });
  const stop = budgetPolicy.endIteration();
  assert.equal(stop, null,
    `iteration ${i} must not terminate while in discovery phase`);
}

// Iteration 8 remains non-terminal and does not force selection until evidence
// readiness has been satisfied.
budgetPolicy.beginIteration(8);
const stopAtDeadline = budgetPolicy.endIteration();
assert.equal(stopAtDeadline, null,
  'iteration 8 (selection deadline) must not terminate the cycle');
assert.equal(budgetPolicy.snapshot().phase, 'discovery',
  'phase must remain discovery until objective evidence readiness exists');

// Selecting at iteration 8 must still succeed
budgetPolicy.selectExperiment(experiment());
assert.ok(budgetPolicy.snapshot().selected_experiment,
  'selection at iteration 8 must succeed');

// ── 4. Objective source propagated through sandbox config ─────────────────────

const sandboxSource = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/sandbox.cjs'),
  'utf8'
);
assert.match(sandboxSource, /objective_source.*maker_requested.*floki_selected|maker_requested.*objective_source/,
  'sandbox.cjs must compute objective_source as maker_requested or floki_selected');
assert.match(sandboxSource, /requested_objective.*options\.objective|options\.objective.*requested_objective/,
  'sandbox.cjs must carry requested_objective from options.objective');

// ── 5. Agent defines pre-selection tool surface ───────────────────────────────

const agentSource = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
assert.match(agentSource, /PRE_SELECTION_BLOCKED_NAMES/,
  'agent must define PRE_SELECTION_BLOCKED_NAMES set');
assert.match(agentSource, /preSelectionTools/,
  'agent must define preSelectionTools discovery surface');
assert.match(agentSource, /pre_selection_mutation_blocked/,
  'agent must use pre_selection_mutation_blocked reason from convergence policy');

// Mutation tools must be in the blocked set
for (const blocked of ['apply_patch', 'write_file', 'run_focused_test', 'run_verification', 'finalize_candidate']) {
  assert.match(agentSource, new RegExp("'" + blocked + "'|\"" + blocked + "\""),
    `agent PRE_SELECTION_BLOCKED_NAMES must include ${blocked}`);
}

// ── 6. Agent encodes autonomous selection vs Maker-requested ─────────────────

assert.match(agentSource, /OBJECTIVE_SOURCE/,
  'agent must read OBJECTIVE_SOURCE from config');
assert.match(agentSource, /MAKER_OBJECTIVE/,
  'agent must read MAKER_OBJECTIVE from config');
assert.match(agentSource, /maker_requested.*MAKER_OBJECTIVE|MAKER_OBJECTIVE.*maker_requested/s,
  'agent must use MAKER_OBJECTIVE when objective_source is maker_requested');
assert.match(agentSource, /select_experiment\.objective.*must match|trimmedMaker|trimmedArgs/,
  'agent must validate that select_experiment.objective matches Maker objective exactly');

// ── 7. UI panel encodes objective field ───────────────────────────────────────

const panelSource = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'),
  'utf8'
);
assert.match(panelSource, /makerObjective/,
  'panel must have makerObjective state');
assert.match(panelSource, /Experiment objective.*optional|optional.*Experiment objective/i,
  'panel must have "Experiment objective — optional" label');
assert.match(panelSource, /runSelfImprovementNow\(trimmedObjective\)/,
  'panel must pass trimmed objective to runSelfImprovementNow');
assert.match(panelSource, /setMakerObjective\(''\)/,
  'panel must clear objective field on verified successful start');
assert.doesNotMatch(panelSource, /window\.prompt\([^)]*improvement objective/,
  'panel must not use window.prompt for objective input');
assert.match(panelSource, /objective_source/,
  'panel must display objective_source from status');
assert.match(panelSource, /Maker-requested|Floki-selected/,
  'panel must display Maker-requested or Floki-selected cycle type label');
assert.match(panelSource, /result\?\.sandbox_started === true/,
  'panel must verify sandbox_started on run now success');
assert.match(panelSource, /nextStatus\?\.current_container/,
  'panel must verify current_container in run now success check');

// ── 8. Crash regression — stop() accepts skipPidDeletion option ──────────────

const runtimeSource = fs.readFileSync(
  path.join(ROOT, 'src/runtime/chat-local-runtime.cjs'),
  'utf8'
);
assert.match(runtimeSource, /async function stop\(options = \{\}\)/,
  'stop() must accept options parameter to support skipPidDeletion');
assert.match(runtimeSource, /skipPidDeletion/,
  'stop() must support skipPidDeletion option to prevent watchdog false-positive during restartChat');
assert.match(runtimeSource, /stop\(\{ skipPidDeletion: true \}\)/,
  'restartChat must call stop({ skipPidDeletion: true }) to preserve PID file during restart');

// ── 9. Promotion carries objective_source to status ──────────────────────────

const promotionSource = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/promotion.cjs'),
  'utf8'
);
assert.match(promotionSource, /objective_source.*maker_requested|maker_requested.*objective_source/,
  'promotion.cjs must set objective_source in status');
assert.match(promotionSource, /requested_objective.*requestedObjective|requestedObjective.*requested_objective/,
  'promotion.cjs must set requested_objective in status');

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_DISCOVERY_BEFORE_SELECTION_CONTRACT_PASS',
  pre_selection_discovery_allowed: true,
  pre_selection_mutation_blocked: true,
  selection_rejection_recovery: true,
  convergence_budget_healthy: true,
  objective_source_in_config: true,
  agent_pre_selection_surface: true,
  ui_objective_field: true,
  crash_regression: true,
  promotion_objective_source: true
}, null, 2));
