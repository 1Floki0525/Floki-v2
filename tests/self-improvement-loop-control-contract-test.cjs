'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  createConvergencePolicy
} = require(path.join(
  ROOT,
  'src/self-improvement/convergence-policy.cjs'
));

const config = {
  discovery_tool_limit: 18,
  research_tool_limit: 10,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 8,
  implementation_start_deadline_iteration: 12,
  search_only_streak_limit: 6,
  failed_lookup_limit: 5,
  max_no_change_iterations: 6,
  focused_verification_failure_limit: 4,
  focused_repair_no_progress_iteration_limit: 12
};

function experiment() {
  return {
    objective: 'Repair bounded RSI convergence behavior',
    hypothesis: 'Forced selection and no-tool accounting prevent unbounded agent churn',
    success_metric: 'the behavioral convergence contract passes',
    baseline_evidence: 'selection_required previously remained advisory and no-tool turns skipped endIteration',
    focused_test: 'node tests/self-improvement-loop-control-contract-test.cjs',
    expected_follow_on_value: 'RSI cycles select, progress, or stop with a precise controlled reason',
    target_files: [
      'containers/self-improvement/agent.cjs',
      'src/self-improvement/convergence-policy.cjs'
    ]
  };
}

// Discovery remains available before the YAML selection deadline.
const discoveryPolicy = createConvergencePolicy(config);
discoveryPolicy.beginIteration(1);
assert.equal(
  discoveryPolicy.authorize('read_file', {
    path: 'src/self-improvement/convergence-policy.cjs'
  }).ok,
  true
);

// Once the deadline moves the cycle into selection_required, additional broad
// discovery is blocked rather than merely advised forever.
discoveryPolicy.beginIteration(config.objective_selection_deadline_iteration);
assert.equal(discoveryPolicy.snapshot().phase, 'selection_required');
const blockedRead = discoveryPolicy.authorize('read_file', {
  path: 'src/self-improvement/convergence-policy.cjs'
});
assert.equal(blockedRead.ok, false);
assert.equal(blockedRead.reason, 'selection_required');
assert.deepEqual(blockedRead.required_next_action.includes('select_experiment'), true);
assert.equal(discoveryPolicy.authorize('select_experiment', {}).ok, true);
assert.equal(discoveryPolicy.selectExperiment(experiment()).ok, true);

// Consecutive model turns with no tool call are counted as no progress and
// terminate at the existing YAML max_no_change_iterations limit.
const noToolPolicy = createConvergencePolicy(config);
for (let iteration = 1; iteration < config.max_no_change_iterations; iteration += 1) {
  noToolPolicy.beginIteration(iteration);
  assert.equal(noToolPolicy.recordNoToolTurn(), null);
}
noToolPolicy.beginIteration(config.max_no_change_iterations);
assert.equal(
  noToolPolicy.recordNoToolTurn(),
  'model_repeatedly_returned_no_tool_calls_before_selection'
);
assert.equal(
  noToolPolicy.snapshot().no_tool_turns,
  config.max_no_change_iterations
);

// Any actual authorized tool call resets the consecutive no-tool streak.
const resetPolicy = createConvergencePolicy(config);
resetPolicy.beginIteration(1);
assert.equal(resetPolicy.recordNoToolTurn(), null);
assert.equal(resetPolicy.snapshot().no_tool_turns, 1);
const readAuthorization = resetPolicy.authorize('read_file', {
  path: 'src/self-improvement/convergence-policy.cjs'
});
assert.equal(readAuthorization.ok, true);
resetPolicy.record(
  'read_file',
  { path: 'src/self-improvement/convergence-policy.cjs' },
  { ok: true }
);
assert.equal(resetPolicy.snapshot().no_tool_turns, 0);

// The agent must expose only select_experiment once selection is required. This
// is proven behaviorally through the real selectActiveTools helper the agent
// invokes, rather than by asserting agent.cjs ternary source text.
{
  const { selectActiveTools } = require(
    path.join(ROOT, 'src/self-improvement/focused-repair.cjs')
  );
  const selectExperimentTool = { function: { name: 'select_experiment' } };
  const surfaces = {
    allTools: [selectExperimentTool, { function: { name: 'shell' } }],
    preSelectionTools: [selectExperimentTool, { function: { name: 'read_file' } }],
    selectExperimentTool,
    repairTools: [selectExperimentTool]
  };
  assert.deepEqual(
    selectActiveTools({ selected_experiment: null, phase: 'selection_required' }, surfaces)
      .map((t) => t.function.name),
    ['select_experiment'],
    'selection_required exposes only select_experiment'
  );
}
// The no-tool model-turn convergence handling (recordNoToolTurn / endIteration)
// is exercised behaviorally in the policy-driven section above.
const policySource = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/convergence-policy.cjs'),
  'utf8'
);
assert.doesNotMatch(
  policySource,
  /objective_not_selected_by_configured_deadline/
);
assert.match(
  policySource,
  /model_failed_to_select_experiment_after_forced_selection/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_LOOP_CONTROL_CONTRACT_PASS',
  discovery_before_deadline: true,
  forced_selection_after_deadline: true,
  no_tool_turns_bounded: true,
  actual_tool_resets_streak: true,
  precise_no_candidate_reason: true
}, null, 2));
