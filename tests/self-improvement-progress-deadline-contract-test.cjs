'use strict';

// Condition-driven execution contract (supersedes the retired progress-deadline
// termination contract): an RSI cycle ends ONLY through candidate
// finalization, an evidence-backed no-safe-candidate decision, Maker
// pause/abort, runtime stop/reset, or a real persisted failure. Safety limits
// (per-command timeouts, model-turn deadline, stall guards) trigger retry,
// correction, explicit preemption, or real failure — never a fabricated
// successful no-candidate result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const {
  readNoSafeCandidateRecord,
  readRunFailureRecord
} = require('../src/self-improvement/worker.cjs');
const {
  createConvergencePolicy
} = require('../src/self-improvement/convergence-policy.cjs');

const config = loadSelfImprovementConfig();

// 1. Run-level wall-clock and iteration budgets are gone; stall guards and the
//    per-request model-turn deadline remain YAML-authoritative safety limits.
for (const removed of [
  'agent_run_wall_clock_budget_ms',
  'iteration_wall_clock_budget_ms',
  'failure_requires_new_activity'
]) {
  assert.equal(
    config[removed],
    undefined,
    removed + ' was retired by the condition-driven execution contract'
  );
}
for (const kept of [
  'model_turn_deadline_ms',
  'implementation_write_deadline_ms',
  'implementation_no_progress_deadline_ms',
  'focused_repair_no_progress_deadline_ms'
]) {
  assert.equal(
    Number.isFinite(Number(config[kept])) && Number(config[kept]) > 0,
    true,
    kept + ' must remain YAML-authoritative and finite'
  );
}

// 2. Agent: stall guards issue one corrective turn, then a real failure.
//    No path converts a safety-limit trip into a successful no-candidate.
const agent = source('containers/self-improvement/agent.cjs');
assert.doesNotMatch(agent, /finishWithoutCandidate/);
assert.doesNotMatch(agent, /agent_run_wall_clock_budget_exceeded/);
assert.doesNotMatch(agent, /iteration_wall_clock_budget_ms/);
assert.match(agent, /function stallCheck\(\)/);
assert.match(agent, /stall_correction_issued/);
assert.match(agent, /return finishWithFailure\(stall\.kind\)/);
assert.match(agent, /function finishWithFailure\(/);
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_RUN_FAILURE/);
assert.match(agent, /process\.exit\(1\)/);
assert.match(agent, /finishWithFailure\('model_transport_failure', error\)/);
assert.match(agent, /function finishWithNoSafeCandidate\(/);
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_NO_SAFE_CANDIDATE/);
assert.match(agent, /report_no_safe_candidate/);
assert.match(agent, /validateNoSafeCandidateDecision/);
assert.match(agent, /selectionDecisionSchema/);
assert.match(agent, /'no_safe_candidate'/);
assert.match(agent, /function normalizeModelPath\(/);

// 3. Worker: no reason list converts stops into no-candidate successes; the
//    evidence-backed record is the only no-candidate path, and a zero exit
//    without an outcome is a real failure.
const worker = source('src/self-improvement/worker.cjs');
assert.doesNotMatch(worker, /NO_CANDIDATE_STOP_REASONS/);
assert.doesNotMatch(worker, /isNoCandidateSandboxFailure/);
assert.match(worker, /readNoSafeCandidateRecord/);
assert.match(worker, /zero_exit_without_outcome/);
assert.match(worker, /stopActiveRunProcess/);
assert.doesNotMatch(
  worker,
  /stopCurrentContainer/,
  'ordinary preemption must stop the run process, never the workstation'
);

// 4. The no-safe-candidate record contract is enforced field by field.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-outcome-'));
try {
  const recordConfig = {
    outbox_root: temp,
    no_safe_candidate_file_name: 'no-safe-candidate.json',
    run_failure_file_name: 'run-failure.json'
  };
  fs.mkdirSync(path.join(temp, 'rsi-run'));
  const file = path.join(temp, 'rsi-run', 'no-safe-candidate.json');
  const complete = {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_NO_SAFE_CANDIDATE',
    run_id: 'rsi-run',
    detailed_reason: 'the evidence shows no bounded safe improvement now',
    evidence_findings: ['finding-1', 'finding-2', 'finding-3'],
    considered_alternatives: [
      { alternative: 'alt-1', rejection_reason: 'too risky' },
      { alternative: 'alt-2', rejection_reason: 'unmeasurable' }
    ],
    evidence_readiness_complete: true,
    phase: 'selection_required'
  };
  fs.writeFileSync(file, JSON.stringify(complete) + '\n');
  assert.ok(readNoSafeCandidateRecord('rsi-run', recordConfig));

  for (const mutate of [
    (row) => { row.evidence_findings = ['one', 'two']; },
    (row) => { row.considered_alternatives = [{ alternative: 'a', rejection_reason: 'r' }]; },
    (row) => { row.considered_alternatives[0].rejection_reason = ''; },
    (row) => { row.detailed_reason = ''; },
    (row) => { row.evidence_readiness_complete = false; },
    (row) => { row.run_id = 'other-run'; },
    (row) => { row.marker = 'WRONG'; }
  ]) {
    const broken = JSON.parse(JSON.stringify(complete));
    mutate(broken);
    fs.writeFileSync(file, JSON.stringify(broken) + '\n');
    assert.equal(
      readNoSafeCandidateRecord('rsi-run', recordConfig),
      null,
      'incomplete no-safe-candidate contracts must be rejected'
    );
  }

  // Real failure records surface the actual persisted error.
  fs.writeFileSync(
    path.join(temp, 'rsi-run', 'run-failure.json'),
    JSON.stringify({
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_RUN_FAILURE',
      run_id: 'rsi-run',
      reason: 'model_transport_failure',
      error: 'ECONNREFUSED'
    }) + '\n'
  );
  const failure = readRunFailureRecord('rsi-run', recordConfig);
  assert.equal(failure.reason, 'model_transport_failure');
  assert.equal(failure.error, 'ECONNREFUSED');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// 5. Convergence policy iteration boundaries steer but never terminate:
//    drive a real policy instance into every historical stop scenario.
const advisories = [];
const policy = createConvergencePolicy(config, (type, detail) => {
  advisories.push({ type, detail });
});
const experimentArgs = {
  objective: 'contract objective',
  hypothesis: 'contract hypothesis',
  success_metric: 'the focused test passes',
  baseline_evidence: 'the current source lacks the capability',
  focused_test: 'node tests/self-improvement-progress-deadline-contract-test.cjs',
  expected_follow_on_value: 'verified behavior',
  target_files: ['src/self-improvement/worker.cjs']
};
policy.beginIteration(1);
policy.selectExperiment(experimentArgs);
policy.startImplementation();
// Far beyond every historical iteration threshold, with no writes and
// repeated focused failures, endIteration must keep returning null.
policy.record('write_file', { path: 'src/self-improvement/worker.cjs' }, {
  ok: true,
  workspace_changed: true
});
for (let iteration = 2; iteration <= 200; iteration += 1) {
  policy.beginIteration(iteration);
  if (iteration % 3 === 0) {
    policy.record('run_focused_test', {}, { ok: false, status: 1 });
  }
  assert.equal(
    policy.endIteration(),
    null,
    'iteration ' + iteration + ': endIteration must never return a stop reason'
  );
}
assert.ok(
  advisories.some((row) => row.type === 'convergence_advisory'),
  'iteration boundaries must keep steering through advisories'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_CONDITION_DRIVEN_EXECUTION_CONTRACT_PASS',
  artificial_termination_removed: true,
  stall_guards_correct_then_fail: true,
  no_safe_candidate_requires_complete_evidence: true,
  zero_exit_without_outcome_is_failure: true,
  run_process_stop_never_stops_workstation: true
}, null, 2));
