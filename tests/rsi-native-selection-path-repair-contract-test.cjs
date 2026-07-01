'use strict';

// Behavioral contract for the native selection path and the bounded focused-test
// repair surface.
//
// This replaces an earlier source-text artifact. It executes the REAL helpers
// the agent uses — src/self-improvement/focused-repair.cjs (selectActiveTools,
// selectRepairTools, buildFocusedRepairContext) — and drives the REAL
// convergence policy to produce the phase snapshots the agent routes on. No
// assertions on agent.cjs source text.

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  REPAIR_ALLOWED_TOOLS,
  REPAIR_WITHHELD_TOOLS,
  isRepairPhase,
  selectActiveTools,
  selectRepairTools,
  buildFocusedRepairContext
} = require(path.join(ROOT, 'src/self-improvement/focused-repair.cjs'));
const {
  createConvergencePolicy
} = require(path.join(ROOT, 'src/self-improvement/convergence-policy.cjs'));

const config = {
  discovery_tool_limit: 18,
  research_tool_limit: 10,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 8,
  implementation_start_deadline_iteration: 12,
  search_only_streak_limit: 6,
  failed_lookup_limit: 5,
  max_no_change_iterations: 6,
  focused_verification_failure_limit: 6,
  focused_repair_no_progress_iteration_limit: 12
};

function experiment() {
  return {
    objective: 'implement one bounded reliability improvement',
    hypothesis: 'one real source change will improve reliability',
    success_metric: 'the focused behavioral test passes',
    baseline_evidence: 'the current focused behavior fails',
    focused_test: 'node tests/focused-reliability-test.cjs',
    expected_follow_on_value: 'reliable autonomous completion',
    target_files: ['src/self-improvement/model-proxy.cjs']
  };
}

// Representative tool surfaces. The agent passes its own arrays; selectActiveTools
// only routes between them by phase, so identity comparison proves the routing.
const selectExperimentTool = { type: 'function', function: { name: 'select_experiment' } };
const allTools = [
  selectExperimentTool,
  { type: 'function', function: { name: 'shell' } },
  { type: 'function', function: { name: 'get_task_state' } },
  { type: 'function', function: { name: 'get_self_context' } },
  { type: 'function', function: { name: 'search_self_memory' } },
  { type: 'function', function: { name: 'list_repository' } },
  { type: 'function', function: { name: 'search_source' } },
  { type: 'function', function: { name: 'inspect_symbol' } },
  { type: 'function', function: { name: 'read_file' } },
  { type: 'function', function: { name: 'apply_patch' } },
  { type: 'function', function: { name: 'write_file' } },
  { type: 'function', function: { name: 'show_diff' } },
  { type: 'function', function: { name: 'git_status' } },
  { type: 'function', function: { name: 'run_focused_test' } },
  { type: 'function', function: { name: 'run_verification' } },
  { type: 'function', function: { name: 'finalize_candidate' } }
];
const PRE_SELECTION_BLOCKED = new Set([
  'apply_patch', 'write_file', 'run_focused_test', 'run_verification', 'finalize_candidate'
]);
const preSelectionTools = allTools.filter((t) => !PRE_SELECTION_BLOCKED.has(t.function.name));
const repairTools = selectRepairTools(allTools, (t) => t.function.name);
const surfaces = { allTools, preSelectionTools, selectExperimentTool, repairTools };
const names = (list) => list.map((t) => t.function.name);

// Drive the real convergence policy to produce genuine phase snapshots.
function discoverySnapshot() {
  const policy = createConvergencePolicy(config);
  policy.beginIteration(1);
  return policy.snapshot();
}
function selectionRequiredSnapshot() {
  const policy = createConvergencePolicy(config);
  for (let i = 1; i <= config.objective_selection_deadline_iteration; i += 1) {
    policy.beginIteration(i);
  }
  return policy.snapshot();
}
function implementingSnapshot() {
  const policy = createConvergencePolicy(config);
  policy.beginIteration(1);
  policy.selectExperiment(experiment());
  policy.startImplementation();
  policy.record('apply_patch', {}, { ok: true, workspace_changed: true });
  return policy.snapshot();
}
function repairingPolicy() {
  const policy = createConvergencePolicy(config);
  policy.beginIteration(1);
  policy.selectExperiment(experiment());
  policy.startImplementation();
  policy.record('apply_patch', {}, { ok: true, workspace_changed: true });
  policy.record('run_focused_test', {}, { ok: false });
  return policy;
}

// 1. Discovery phase gets the normal pre-selection discovery tools.
{
  const snap = discoverySnapshot();
  assert.equal(snap.phase, 'discovery');
  assert.equal(snap.selected_experiment, null);
  assert.equal(selectActiveTools(snap, surfaces), preSelectionTools);
  for (const blocked of PRE_SELECTION_BLOCKED) {
    assert.ok(!names(preSelectionTools).includes(blocked), 'discovery withholds ' + blocked);
  }
}

// 2. selection_required gets the native select_experiment path only.
{
  const snap = selectionRequiredSnapshot();
  assert.equal(snap.phase, 'selection_required');
  const active = selectActiveTools(snap, surfaces);
  assert.deepEqual(names(active), ['select_experiment'], 'selection_required offers native select_experiment only');
}

// 3. implementing gets the full implementation tool surface.
{
  const snap = implementingSnapshot();
  assert.equal(snap.phase, 'implementing');
  assert.ok(snap.selected_experiment, 'experiment selected during implementation');
  assert.equal(selectActiveTools(snap, surfaces), allTools);
}

// 4. repairing gets the bounded focused-repair tool set.
{
  const policy = repairingPolicy();
  const snap = policy.snapshot();
  assert.equal(snap.phase, 'repairing');
  assert.ok(isRepairPhase(snap.phase));
  const active = selectActiveTools(snap, surfaces);
  assert.equal(active, repairTools);
  for (const tool of ['read_file', 'apply_patch', 'write_file', 'run_focused_test', 'search_source', 'inspect_symbol', 'show_diff', 'git_status', 'get_task_state']) {
    assert.ok(names(active).includes(tool), 'repair surface includes ' + tool);
  }
}

// 5/6/7. repairing excludes generic shell, run_verification, finalize_candidate.
{
  const policy = repairingPolicy();
  const active = selectActiveTools(policy.snapshot(), surfaces);
  for (const withheld of REPAIR_WITHHELD_TOOLS) {
    assert.ok(!names(active).includes(withheld), 'repair surface excludes ' + withheld);
  }
  assert.ok(!names(active).includes('shell'));
  assert.ok(!names(active).includes('run_verification'));
  assert.ok(!names(active).includes('finalize_candidate'));
}

// 8. The latest failing command, stdout, and stderr are included in the repair
//    context.
{
  const ctx = buildFocusedRepairContext(
    {
      command: 'node tests/focused-reliability-test.cjs',
      status: 1,
      stdout_tail: 'AssertionError: expected false to be true',
      stderr_tail: 'at Object.<anonymous>',
      changed_files_after_test: ['src/self-improvement/model-proxy.cjs']
    },
    ['src/self-improvement/model-proxy.cjs']
  );
  assert.match(ctx, /node tests\/focused-reliability-test\.cjs/);
  assert.match(ctx, /AssertionError: expected false to be true/);
  assert.match(ctx, /at Object\.<anonymous>/);
  assert.match(ctx, /exit status: 1/);
  assert.match(ctx, /do NOT add fake helpers/i);
  assert.match(ctx, /run_focused_test/);
}

// 9. A failed focused test can be repaired and rerun: re-running it green leaves
//    the repairing phase, restoring the full surface for verification.
{
  const policy = repairingPolicy();
  assert.equal(policy.snapshot().phase, 'repairing');
  policy.record('apply_patch', {}, { ok: true, workspace_changed: true });
  policy.record('run_focused_test', {}, { ok: true });
  const snap = policy.snapshot();
  assert.equal(snap.phase, 'focused_verified', 'a passing focused test leaves repair');
  assert.ok(!isRepairPhase(snap.phase));
  assert.equal(selectActiveTools(snap, surfaces), allTools, 'full surface returns after repair');
}

// 10. Native select_experiment still auto-starts implementation after a
//     successful selection (the mechanism the agent invokes).
{
  const policy = createConvergencePolicy(config);
  policy.beginIteration(1);
  const selected = policy.selectExperiment(experiment());
  assert.equal(selected.ok, true, 'native select_experiment succeeds');
  assert.ok(policy.snapshot().selected_experiment, 'experiment recorded');
  const started = policy.startImplementation();
  assert.equal(started.ok, true, 'implementation auto-starts after selection');
  assert.equal(policy.snapshot().implementation_started, true);
}

assert.deepEqual(
  REPAIR_ALLOWED_TOOLS.filter((t) => REPAIR_WITHHELD_TOOLS.includes(t)),
  [],
  'repair allow/withhold sets are disjoint'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_NATIVE_SELECTION_PATH_REPAIR_CONTRACT_PASS',
  repair_allowed_tools: REPAIR_ALLOWED_TOOLS,
  repair_withheld_tools: REPAIR_WITHHELD_TOOLS
}, null, 2));
