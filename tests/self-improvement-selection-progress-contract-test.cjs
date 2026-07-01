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
    objective: 'implement one bounded reliability improvement',
    hypothesis: 'one real source change will improve reliability',
    success_metric: 'the focused behavioral test passes',
    baseline_evidence: 'the current focused behavior fails',
    focused_test: 'node tests/focused-reliability-test.cjs',
    expected_follow_on_value: 'reliable autonomous completion',
    target_files: ['src/self-improvement/model-proxy.cjs']
  };
}

const policy = createConvergencePolicy(config);
for (let iteration = 1; iteration <= 8; iteration += 1) {
  policy.beginIteration(iteration);
}
policy.selectExperiment(experiment());
assert.equal(policy.snapshot().selected_experiment_at_iteration, 8);
assert.equal(policy.endIteration(), null);

for (let iteration = 9; iteration <= 13; iteration += 1) {
  policy.beginIteration(iteration);
  assert.equal(
    policy.endIteration(),
    null,
    'selection must receive the YAML max_no_change_iterations grace window'
  );
}

policy.beginIteration(14);
assert.equal(
  policy.endIteration(),
  'implementation_not_started_after_selection_grace'
);

const implementationPolicy = createConvergencePolicy(config);
implementationPolicy.beginIteration(1);
implementationPolicy.selectExperiment(experiment());
implementationPolicy.startImplementation();
assert.equal(implementationPolicy.snapshot().implementation_started, true);
assert.match(
  implementationPolicy.feedback(),
  /Make the next tool call apply_patch or write_file/
);

const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
assert.match(agent, /implementation_auto_started_after_selection/);
assert.match(
  agent,
  /name === 'select_experiment'[\s\S]*convergencePolicy\.startImplementation\(\)/
);
assert.match(
  agent,
  /The experiment is selected and the implementation phase is active/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_SELECTION_PROGRESS_CONTRACT_PASS',
  selection_iteration: 8,
  implementation_grace_stop_iteration: 14,
  automatic_implementation_transition: true,
  immediate_implementation_feedback: true
}, null, 2));
