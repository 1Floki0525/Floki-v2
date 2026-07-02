'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  classifyExperimentAgainstPriors,
  validateDeniedRevisionPlan
} = require(path.join(
  __dirname,
  '..',
  'src/self-improvement/candidate-dedup.cjs'
));
const {
  buildDeniedRevisionContext,
  buildFocusedRepairContext
} = require(path.join(
  __dirname,
  '..',
  'src/self-improvement/focused-repair.cjs'
));

const options = {
  occupied_candidate_statuses: 'pending_review',
  candidate_dedup_strong_objective_similarity_min: 0.65,
  candidate_dedup_strong_hypothesis_similarity_min: 0.60,
  candidate_dedup_focused_test_objective_similarity_min: 0.65,
  candidate_dedup_focused_test_file_overlap_min: 0.50,
  candidate_dedup_focused_test_text_similarity_min: 0.45,
  candidate_dedup_moderate_objective_similarity_min: 0.50,
  candidate_dedup_moderate_hypothesis_similarity_min: 0.50,
  candidate_dedup_high_file_overlap_min: 0.80
};

const denied = {
  id: 'generated-denied-candidate',
  status: 'denied',
  objective: 'Improve transport retry workflow with behavioral recovery proof',
  denial_reason:
    'The prior test only asserted a classification helper. Exercise the real caller and prove a second model request occurs.',
  experiment: {
    objective: 'Improve transport retry workflow with behavioral recovery proof',
    hypothesis: 'Transient failures should enter a bounded caller retry path',
    target_files: [
      'src/self-improvement/transient-model-error.cjs',
      'containers/self-improvement/agent.cjs'
    ],
    focused_test: 'node tests/generated-retry-behavior-contract-test.cjs'
  }
};

const proposed = {
  objective: denied.experiment.objective,
  hypothesis: denied.experiment.hypothesis,
  target_files: denied.experiment.target_files,
  focused_test: denied.experiment.focused_test
};

const classification = classifyExperimentAgainstPriors(
  proposed,
  [denied],
  options
);
assert.equal(classification.decision, 'revise');

const absent = validateDeniedRevisionPlan(classification, proposed);
assert.equal(absent.ok, false);
assert.match(absent.reason, /denial_revision_plan/);

const incomplete = validateDeniedRevisionPlan(classification, {
  ...proposed,
  denial_revision_plan: {
    denial_requirement: denied.denial_reason,
    implementation_change: 'Expose and exercise the production caller path.'
  }
});
assert.equal(incomplete.ok, false);
assert.match(incomplete.reason, /focused_test_change/);

const completePlan = {
  denial_requirement: denied.denial_reason,
  implementation_change:
    'Drive the real retry orchestration instead of reproducing its boolean classification.',
  focused_test_change:
    'Assert the first model call fails transiently, a second real request occurs, and a non-retryable control does not retry.'
};
const accepted = validateDeniedRevisionPlan(classification, {
  ...proposed,
  denial_revision_plan: completePlan
});
assert.equal(accepted.ok, true);
assert.deepEqual(accepted.plan, completePlan);

const revisionConstraint = {
  revising_denied: denied.id,
  denial_reason: denied.denial_reason,
  plan: accepted.plan
};
const context = buildDeniedRevisionContext(revisionConstraint);
assert.match(context, /DENIED-CANDIDATE REVISION CONSTRAINT/);
assert.match(context, /real caller/);
assert.match(context, /second real request/);

const repairContext = buildFocusedRepairContext(
  {
    command: proposed.focused_test,
    status: 1,
    stdout_tail: 'non-retryable control returned false',
    stderr_tail: 'AssertionError',
    timed_out: false
  },
  proposed.target_files,
  revisionConstraint
);
assert.match(repairContext, /generated test can be the broken side/);
assert.match(repairContext, /DENIED-CANDIDATE REVISION CONSTRAINT/);
assert.match(repairContext, /Do not repeat the denied implementation/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_DENIED_REVISION_ENFORCEMENT_CONTRACT_PASS',
  missing_plan_rejected: true,
  structured_revision_plan_required: true,
  denial_context_reinjected_during_repair: true
}, null, 2));
