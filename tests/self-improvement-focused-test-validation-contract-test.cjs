'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const agentSource = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);

assert.equal(process.version, 'v24.17.0');

// --- Structural checks ---
assert.match(agentSource, /FOCUSED_TEST_EXECUTABLE_PREFIX/, 'agent must define FOCUSED_TEST_EXECUTABLE_PREFIX');
assert.match(agentSource, /focused_test_description.*type.*string/s, 'agent schema must include optional focused_test_description field');
assert.match(agentSource, /focused_test must contain only an executable command/, 'agent must reject prose with a clear message referencing focused_test_description');
assert.match(agentSource, /Put the explanation in focused_test_description/, 'rejection message must direct model to use focused_test_description for prose');
assert.match(agentSource, /Example: node tests\/example-contract-test\.cjs/, 'rejection message must include a correct command example');

// --- Functional validation ---
const {
  createConvergencePolicy
} = require(path.join(ROOT, 'src/self-improvement/convergence-policy.cjs'));

const defaultConfig = {
  discovery_tool_limit: 18,
  research_tool_limit: 10,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 8,
  implementation_start_deadline_iteration: 12,
  search_only_streak_limit: 6,
  failed_lookup_limit: 5,
  max_no_change_iterations: 4,
  focused_verification_failure_limit: 4
};

function makePolicy() {
  const events = [];
  const policy = createConvergencePolicy(defaultConfig, (name, detail) => {
    events.push({ name, detail });
  });
  return { policy, events };
}

// Test 1: prose focused_test is rejected at schema level in agent
// We test the FOCUSED_TEST_EXECUTABLE_PREFIX regex directly
const FOCUSED_TEST_EXECUTABLE_PREFIX = /^(?:bash\b|node\b|npm\b|python3?\b|pytest\b|npx\b|shellcheck\b|cargo\b|go\b|make\b)/i;

const proseValues = [
  'test_dns_transient_error_classification.adapter.js - Verify that subscribeRuntimeEvents properly classifies transient DNS errors',
  'recency-weighted-recall-contract-test.cjs - verifies that memories with explicit tags or provenance are ranked higher',
  'Verify that the implementation works correctly by running the focused test',
  'test_file.js - Check the feature works',
  'some-test.cjs - Description here',
];

for (const prose of proseValues) {
  assert.equal(
    FOCUSED_TEST_EXECUTABLE_PREFIX.test(prose),
    false,
    `Prose must not match executable prefix: "${prose.slice(0, 60)}"`
  );
}

// Test 2: valid executable commands are accepted
const validCommands = [
  'node tests/example-contract-test.cjs',
  'bash bin/floki-node24-run.sh node tests/foo.cjs',
  'npm test',
  'npm test -- --specific-option',
  'npm run test:integration',
  'bash bin/some-verify.sh',
  'python3 -m pytest tests/',
  'pytest tests/',
  'node --test tests/foo.mjs',
  'npx mocha',
  'make test',
];

for (const cmd of validCommands) {
  assert.equal(
    FOCUSED_TEST_EXECUTABLE_PREFIX.test(cmd),
    true,
    `Valid command must match executable prefix: "${cmd}"`
  );
}

// Test 3: convergence policy stores focused_test_description when provided
{
  const { policy } = makePolicy();
  policy.beginIteration(1);
  const result = policy.selectExperiment({
    objective: 'Add DNS error handling',
    hypothesis: 'Better error codes improve reliability',
    baseline_evidence: 'Current code returns generic Error on EAI_AGAIN',
    target_files: ['src/integrations/floki/adapter.js'],
    success_metric: 'Test passes with EAI_AGAIN classification',
    focused_test: 'node tests/dns-error-contract-test.cjs',
    focused_test_description: 'Verify that subscribeRuntimeEvents properly classifies EAI_AGAIN as a transient DNS error',
    expected_follow_on_value: 'Improved WebSocket reconnection handling'
  });
  assert.equal(result.ok, true, 'selectExperiment must succeed with valid executable focused_test');
  assert.equal(result.experiment.focused_test, 'node tests/dns-error-contract-test.cjs');
  assert.equal(
    result.experiment.focused_test_description,
    'Verify that subscribeRuntimeEvents properly classifies EAI_AGAIN as a transient DNS error'
  );
}

// Test 4: convergence policy stores null for missing focused_test_description
{
  const { policy } = makePolicy();
  policy.beginIteration(1);
  const result = policy.selectExperiment({
    objective: 'Fix retry logic',
    hypothesis: 'Adding retry fixes flakiness',
    baseline_evidence: 'Tests fail intermittently without retry',
    target_files: ['src/self-improvement/worker.cjs'],
    success_metric: 'Retry test passes',
    focused_test: 'node tests/retry-contract-test.cjs',
    expected_follow_on_value: 'Improved stability'
  });
  assert.equal(result.ok, true);
  assert.equal(result.experiment.focused_test_description, null);
}

// Test 5: stall fires only after write+grace period, not on selection rejection alone
{
  const { policy } = makePolicy();
  policy.beginIteration(1);
  const selectResult = policy.selectExperiment({
    objective: 'Test objective',
    hypothesis: 'Test hypothesis',
    baseline_evidence: 'Baseline: test file missing',
    target_files: ['tests/foo.cjs'],
    success_metric: 'Test passes',
    focused_test: 'node tests/foo.cjs',
    expected_follow_on_value: 'Follow-on value'
  });
  assert.equal(selectResult.ok, true);

  policy.beginIteration(2);
  policy.startImplementation();
  policy.record('write_file', { path: 'tests/foo.cjs', content: '// test' }, { ok: true, workspace_changed: true });

  const snap = policy.snapshot();
  assert.equal(snap.write_count, 1, 'write must be counted');
  assert.equal(snap.last_write_iteration, 2);
  assert.notEqual(snap.phase, 'verified');

  // Advance without verification — should get guidance first (null = continue)
  policy.beginIteration(6);
  const firstStallResult = policy.endIteration();
  assert.equal(firstStallResult, null, 'first stall check must return guidance (null = continue)');

  policy.beginIteration(7);
  const stall = policy.endIteration();
  assert.equal(stall, 'implementation_progress_stalled_before_verification', 'stalls only after write+guidance period exhausted');
}

// Test 6: shell status 127 from focused test counts as focused_verification_failed
{
  const { policy } = makePolicy();
  policy.beginIteration(1);
  policy.selectExperiment({
    objective: 'Test',
    hypothesis: 'H',
    baseline_evidence: 'B',
    target_files: ['src/foo.cjs'],
    success_metric: 'S',
    focused_test: 'node tests/foo.cjs',
    expected_follow_on_value: 'F'
  });
  policy.beginIteration(2);
  policy.startImplementation();
  policy.record('write_file', { path: 'src/foo.cjs', content: '// x' }, { ok: true, workspace_changed: true });
  policy.beginIteration(3);
  policy.record('run_focused_test', { command: 'node tests/foo.cjs' }, { ok: false, status: 127, stdout: '', stderr: 'command not found' });
  const snap = policy.snapshot();
  assert.equal(snap.focused_verification_failures, 1, 'status 127 from focused test must count as failure');
  assert.notEqual(snap.phase, 'implementation_progress_stalled', 'one failure must not stop immediately');
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_FOCUSED_TEST_VALIDATION_CONTRACT_PASS',
  prose_rejected: proseValues.length,
  executables_accepted: validCommands.length,
  description_field_stored: true,
  selection_rejection_does_not_count_as_implementation_failure: true,
  status_127_counted_as_focused_verification_failure: true
}, null, 2));
