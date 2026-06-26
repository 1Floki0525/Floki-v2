'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  createConvergencePolicy,
  isReadOnlyShell
} = require(path.join(root, 'src/self-improvement/convergence-policy.cjs'));

const config = {
  discovery_tool_limit: 18,
  research_tool_limit: 10,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 8,
  implementation_start_deadline_iteration: 12,
  search_only_streak_limit: 6,
  failed_lookup_limit: 5,
  max_no_change_iterations: 6,
  focused_verification_failure_limit: 3
};

assert.equal(
  isReadOnlyShell('find /workspace -type f 2>/dev/null | head -50'),
  true
);
assert.equal(
  isReadOnlyShell('cd /workspace && find tests -name "*.cjs" | head -5'),
  true
);
assert.equal(
  isReadOnlyShell('grep -r "idle" src 2>/dev/null | head -40'),
  true
);
assert.equal(isReadOnlyShell('git status --short 2>&1'), true);
assert.equal(isReadOnlyShell('printf x > src/example.cjs'), false);

const events = [];
const policy = createConvergencePolicy(config, (type, detail) => {
  events.push({ type, detail });
});
policy.beginIteration(1);
const readArgs = {
  command: 'find /workspace -type f 2>/dev/null | head -50'
};
const preSelectionRead = policy.authorize('shell', readArgs);
assert.equal(preSelectionRead.ok, true,
  'read-only shell command must be allowed before selection for evidence gathering');

const preSelectionMutation = policy.authorize(
  'shell',
  { command: 'printf x > src/example.cjs' }
);
assert.equal(preSelectionMutation.ok, false,
  'mutating shell command must be blocked before selection');
assert.equal(preSelectionMutation.reason, 'pre_selection_mutation_blocked',
  'mutating shell block must use pre_selection_mutation_blocked reason');

policy.selectExperiment({
  objective: 'repair one bounded behavior',
  hypothesis: 'a real source change fixes it',
  success_metric: 'focused test passes',
  baseline_evidence: 'current focused test fails',
  focused_test: 'node tests/focused.cjs',
  expected_follow_on_value: 'reliable RSI completion',
  target_files: ['src/example.cjs']
});
assert.equal(policy.authorize('shell', readArgs).ok, true);
policy.record('shell', readArgs, {
  status: 0,
  workspace_changed: false
});
assert.equal(policy.snapshot().implementation_started, false);
assert.equal(policy.snapshot().write_count, 0);

const preWritePolicy = createConvergencePolicy(config);
preWritePolicy.beginIteration(1);
preWritePolicy.selectExperiment({
  objective: 'repair one bounded behavior',
  hypothesis: 'a real source change fixes it',
  success_metric: 'focused test passes',
  baseline_evidence: 'current focused test fails',
  focused_test: 'node tests/focused.cjs',
  expected_follow_on_value: 'reliable RSI completion',
  target_files: ['src/example.cjs']
});
preWritePolicy.startImplementation();
preWritePolicy.beginIteration(2);
assert.equal(
  preWritePolicy.authorize('read_file', { path: 'src/example.cjs' }).ok,
  true
);
preWritePolicy.beginIteration(4);
assert.equal(
  preWritePolicy.authorize('read_file', { path: 'src/example.cjs' }).ok,
  true
);
assert.equal(
  preWritePolicy.authorize('search_source', {
    path: 'src/example.cjs',
    query: 'module.exports'
  }).ok,
  true
);
const preWriteBlockedRead = preWritePolicy.authorize(
  'read_file',
  { path: 'src/other.cjs' }
);
assert.equal(preWriteBlockedRead.ok, false);
assert.equal(preWriteBlockedRead.reason, 'implementation_write_required');
assert.match(preWriteBlockedRead.required_next_action, /apply_patch or write_file/);
assert.match(preWriteBlockedRead.required_next_action, /target files remain allowed/);
preWritePolicy.beginIteration(7);
assert.equal(preWritePolicy.endIteration(), null);
assert.equal(
  preWritePolicy.snapshot().no_write_guidance_issued_at_iteration,
  7
);
preWritePolicy.beginIteration(8);
assert.equal(
  preWritePolicy.endIteration(),
  'implementation_has_no_workspace_change'
);

policy.selectExperiment({
  objective: 'repair one bounded behavior',
  hypothesis: 'a real source change fixes it',
  success_metric: 'focused test passes',
  baseline_evidence: 'current focused test fails',
  focused_test: 'node tests/focused.cjs',
  expected_follow_on_value: 'reliable RSI completion',
  target_files: ['src/example.cjs']
});
policy.startImplementation();
policy.record('shell', { command: 'grep -n x src/example.cjs 2>/dev/null' }, {
  status: 0,
  workspace_changed: false
});
assert.equal(policy.snapshot().write_count, 0);

policy.record('shell', { command: 'printf x > src/example.cjs' }, {
  status: 0,
  workspace_changed: true
});
assert.equal(policy.snapshot().write_count, 0);
assert.equal(policy.snapshot().last_write_iteration, null);
assert.equal(
  events.some((event) => {
    return event.type === 'convergence_advisory' &&
      event.detail.reason === 'shell_mutation_not_structured_progress';
  }),
  true
);

policy.record('apply_patch', { patch: 'diff --git a/src/example.cjs b/src/example.cjs' }, {
  ok: true,
  workspace_changed: true
});
assert.equal(policy.snapshot().write_count, 1);
assert.equal(policy.snapshot().last_write_iteration, 1);

policy.beginIteration(2);
assert.equal(policy.authorize('read_file', { path: 'src/example.cjs' }).ok, true);

policy.beginIteration(4);
assert.equal(policy.authorize('read_file', { path: 'src/example.cjs' }).ok, true);
const blockedRead = policy.authorize('read_file', { path: 'src/other.cjs' });
assert.equal(blockedRead.ok, false);
assert.equal(blockedRead.reason, 'post_write_verification_required');
assert.match(blockedRead.required_next_action, /Run the focused test/);
const blockedShellRead = policy.authorize('shell', {
  command: 'cd /workspace && find tests -name "*.cjs" | head -5'
});
assert.equal(blockedShellRead.ok, false);
assert.equal(blockedShellRead.reason, 'post_write_verification_required');
assert.match(blockedShellRead.required_next_action, /run_focused_test/);

let stopReason = null;
for (let iteration = 5; iteration <= 8; iteration += 1) {
  policy.beginIteration(iteration);
  stopReason = policy.endIteration();
  if (iteration === 7) {
    assert.equal(stopReason, null);
    assert.equal(
      policy.snapshot().post_write_guidance_issued_at_iteration,
      7
    );
  }
}
assert.equal(stopReason, 'implementation_progress_stalled_before_verification');
assert.equal(policy.snapshot().verification_runs, 0);

const focusedFailurePolicy = createConvergencePolicy(config);
focusedFailurePolicy.beginIteration(1);
focusedFailurePolicy.selectExperiment({
  objective: 'repair one bounded focused-test failure loop',
  hypothesis: 'bounded focused verification failures stop runaway repair',
  success_metric: 'focused test failure loop stops cleanly',
  baseline_evidence: 'current focused test fails repeatedly',
  focused_test: 'node tests/focused.cjs',
  expected_follow_on_value: 'runaway repair loops terminate visibly',
  target_files: ['src/example.cjs']
});
focusedFailurePolicy.startImplementation();
focusedFailurePolicy.record('apply_patch', { patch: 'diff --git a/src/example.cjs b/src/example.cjs' }, {
  ok: true,
  workspace_changed: true
});
let focusedStopReason = null;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  focusedFailurePolicy.beginIteration(attempt + 1);
  focusedFailurePolicy.record('run_focused_test', {}, {
    ok: false,
    status: 1,
    workspace_changed: false
  });
  focusedFailurePolicy.record('write_file', { path: 'src/example.cjs' }, {
    ok: true,
    workspace_changed: true
  });
  focusedStopReason = focusedFailurePolicy.endIteration();
}
assert.equal(focusedStopReason, 'focused_verification_failed_repeatedly');
assert.equal(
  focusedFailurePolicy.snapshot().focused_verification_failures,
  3
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_CONVERGENCE_REAL_WRITE_CONTRACT_PASS',
  benign_redirects_are_reads: true,
  write_count_requires_real_workspace_change: true,
  target_reads_remain_allowed_until_write: true,
  no_write_guidance_gets_a_correction_turn: true,
  shell_mutations_do_not_count_as_structured_progress: true,
  unrelated_post_write_reads_are_blocked_until_verification: true,
  post_write_guidance_gets_a_verification_turn: true,
  cd_find_shell_reads_are_blocked_after_write: true,
  stalled_loop_stops: true,
  repeated_focused_test_failure_stops: true
}, null, 2));
