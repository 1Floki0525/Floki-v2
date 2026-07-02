'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createConvergencePolicy
} = require(path.join(
  __dirname,
  '..',
  'src/self-improvement/convergence-policy.cjs'
));

function config(overrides = {}) {
  return {
    discovery_tool_limit: 18,
    research_tool_limit: 10,
    repeated_tool_signature_limit: 2,
    objective_selection_deadline_iteration: 8,
    implementation_start_deadline_iteration: 12,
    search_only_streak_limit: 6,
    failed_lookup_limit: 5,
    max_no_change_iterations: 6,
    focused_verification_failure_limit: 3,
    focused_repair_no_progress_iteration_limit: 12,
    ...overrides
  };
}

function selectAndWrite(policy) {
  policy.beginIteration(1);
  assert.equal(policy.selectExperiment({
    objective: 'Repair a generated focused test through the real production loop',
    hypothesis: 'Dedicated repair convergence prevents premature generic stalls',
    baseline_evidence: 'The old loop stopped with implementation_progress_stalled_before_verification',
    target_files: [
      'src/self-improvement/convergence-policy.cjs',
      'tests/generated-focused-test.cjs'
    ],
    success_metric: 'The failed test can be repaired and rerun before full verification',
    focused_test: 'node tests/generated-focused-test.cjs',
    expected_follow_on_value: 'Run Now can recover from an incorrect generated test'
  }).ok, true);
  policy.beginIteration(2);
  assert.equal(policy.startImplementation().ok, true);
  policy.record(
    'write_file',
    { path: 'tests/generated-focused-test.cjs', content: '// initial generated test' },
    { ok: true, workspace_changed: true }
  );
}

// A focused-test failure owns the convergence path. The generic post-write
// stall must not terminate repair before the dedicated repair budget expires.
{
  const events = [];
  const policy = createConvergencePolicy(config(), (type, detail) => {
    events.push({ type, detail });
  });
  selectAndWrite(policy);
  policy.beginIteration(3);
  policy.record(
    'run_focused_test',
    { command: 'node tests/generated-focused-test.cjs' },
    { ok: false, status: 1, stdout: 'control=false', stderr: 'AssertionError' }
  );
  assert.equal(policy.snapshot().phase, 'repairing');
  assert.match(policy.guidance(), /First use read_file to re-read the failing test/);
  assert.doesNotMatch(policy.guidance(), /Call run_focused_test now/);

  for (let iteration = 4; iteration < 15; iteration += 1) {
    policy.beginIteration(iteration);
    assert.equal(
      policy.endIteration(),
      null,
      'repair must not be ended by generic implementation stall at iteration ' + iteration
    );
  }
  assert.equal(
    events.some((entry) =>
      entry.type === 'convergence_advisory' &&
      entry.detail.reason === 'implementation_progress_stalled_before_verification'
    ),
    false,
    'generic post-write stall must not fire during focused repair'
  );

  policy.beginIteration(10);
  policy.record(
    'apply_patch',
    { patch: 'repair generated control assertion' },
    { ok: true, workspace_changed: true }
  );
  assert.equal(policy.snapshot().phase, 'repairing');
  assert.match(policy.guidance(), /Call run_focused_test now/);

  policy.beginIteration(11);
  policy.record(
    'run_focused_test',
    { command: 'node tests/generated-focused-test.cjs' },
    { ok: true, status: 0, stdout: 'pass', stderr: '' }
  );
  assert.equal(policy.snapshot().phase, 'focused_verified');
  assert.match(policy.guidance(), /Call run_verification now/);
}

// A repair that makes no structured progress is still bounded, but receives a
// precise repair-specific stop reason instead of a misleading generic stall.
{
  const policy = createConvergencePolicy(config({
    focused_repair_no_progress_iteration_limit: 4
  }));
  selectAndWrite(policy);
  policy.beginIteration(3);
  policy.record(
    'run_focused_test',
    { command: 'node tests/generated-focused-test.cjs' },
    { ok: false, status: 1 }
  );
  policy.beginIteration(7);
  assert.equal(policy.endIteration(), 'focused_repair_progress_stalled');
}

// Repeated actual focused-test failures remain bounded by the independent YAML
// failure budget.
{
  const policy = createConvergencePolicy(config({
    focused_verification_failure_limit: 2
  }));
  selectAndWrite(policy);
  policy.beginIteration(3);
  policy.record('run_focused_test', {}, { ok: false, status: 1 });
  policy.beginIteration(4);
  policy.record('apply_patch', {}, { ok: true, workspace_changed: true });
  policy.beginIteration(5);
  policy.record('run_focused_test', {}, { ok: false, status: 1 });
  assert.equal(policy.endIteration(), 'focused_verification_failed_repeatedly');
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_FOCUSED_REPAIR_CONVERGENCE_CONTRACT_PASS',
  generated_test_can_be_repaired: true,
  generic_stall_suppressed_during_repair: true,
  repair_no_progress_bounded: true,
  focused_failure_budget_preserved: true
}, null, 2));
