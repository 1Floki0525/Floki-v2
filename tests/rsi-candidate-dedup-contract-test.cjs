'use strict';

// Candidate-agnostic RSI deduplication contract.
//
// This test builds isolated temporary candidate roots, loads them through the
// production snapshot history reader, and classifies with the production helper.
// It intentionally avoids live candidate contents, real candidate IDs, real
// objectives, fixed candidate counts, and one-off objective-specific cases.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  classifyExperimentAgainstPriors,
  configuredOccupiedStatuses,
  isOccupiedStatus,
  similarityPolicy
} = require(path.join(ROOT, 'src/self-improvement/candidate-dedup.cjs'));
const { loadSelfImprovementConfig } = require(
  path.join(ROOT, 'src/self-improvement/config.cjs')
);
const { readPriorCandidateHistory } = require(
  path.join(ROOT, 'src/self-improvement/snapshot.cjs')
);

const productionConfig = loadSelfImprovementConfig();
const occupiedStatuses = configuredOccupiedStatuses(productionConfig);
assert.deepEqual(
  occupiedStatuses,
  ['pending_review'],
  'YAML duplicate-blocking policy must only treat the pending review list as occupied'
);

const classifierOptions = { ...productionConfig };
const policy = similarityPolicy(classifierOptions);
for (const [key, value] of Object.entries(policy)) {
  assert.equal(Number.isFinite(value), true, key + ' must be YAML-backed numeric policy');
}

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-dedup-' + name + '-'));
}

function scenarioToken(index) {
  return 'scenario' + String(index).padStart(3, '0');
}

function experiment(token, kind = 'base', overrides = {}) {
  return {
    objective: [
      'Improve',
      token,
      kind,
      'selection guard for durable worker transition'
    ].join(' '),
    hypothesis: [
      'The',
      token,
      kind,
      'guard prevents duplicate work while preserving revised proposals'
    ].join(' '),
    target_files: [
      'src/generated/' + token + '/selector.cjs',
      'tests/generated/' + token + '-selector-contract.cjs'
    ],
    focused_test: 'node tests/generated/' + token + '-selector-contract.cjs',
    ...overrides
  };
}

function nearExperiment(token) {
  return experiment(token, 'base', {
    objective: 'Improve ' + token + ' selection guard for durable transition workers',
    hypothesis:
      'The ' + token + ' guard prevents duplicate implementation while preserving revised proposals'
  });
}

function unrelatedExperiment(token, sharedFiles = []) {
  return experiment(token, 'unrelated', {
    objective: 'Add ' + token + ' telemetry export for bounded runtime activity',
    hypothesis: 'The ' + token + ' telemetry export improves observability without changing selection',
    target_files: sharedFiles.concat(['src/generated/' + token + '/telemetry.cjs']),
    focused_test: 'node tests/generated/' + token + '-telemetry-contract.cjs'
  });
}

function revisedExperiment(token) {
  return experiment(token, 'revised', {
    objective: 'Add ' + token + ' queue depth metric for runtime reporting',
    hypothesis: 'A ' + token + ' queue depth metric proves observability without repeating selection work',
    target_files: ['src/generated/' + token + '/metrics.cjs'],
    focused_test: 'node tests/generated/' + token + '-metrics-contract.cjs'
  });
}

function candidate(id, status, candidateExperiment, extra = {}) {
  const created = extra.created_at || '2026-01-01T00:00:00.000Z';
  const updated = extra.updated_at || created;
  const nestedExperiment = extra.experiment === undefined ? candidateExperiment : extra.experiment;
  return {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_CANDIDATE',
    id,
    status,
    candidate_type: extra.candidate_type || 'code_patch',
    objective: extra.top_level_objective || candidateExperiment.objective,
    experiment: nestedExperiment,
    changed_files: extra.changed_files || candidateExperiment.target_files,
    focused_test: extra.top_level_focused_test || candidateExperiment.focused_test,
    denial_reason: extra.denial_reason || null,
    failure: extra.failure || null,
    created_at: created,
    updated_at: updated
  };
}

function writeCandidate(root, manifest, options = {}) {
  const dir = path.join(root, manifest.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (options.emptyOnly === true) return;
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 }
  );
  if (manifest.status === 'denied') {
    fs.writeFileSync(
      path.join(dir, 'changes.diff'),
      'diff --git a/' + manifest.id + ' b/' + manifest.id + '\n',
      { mode: 0o600 }
    );
  }
}

function loadHistory(root, limit = 1000) {
  assert.notEqual(path.resolve(root), path.resolve(productionConfig.candidate_root));
  return readPriorCandidateHistory({
    config: {
      ...productionConfig,
      candidate_root: root,
      prior_candidate_history_limit: limit
    }
  });
}

function classify(proposed, priors) {
  return classifyExperimentAgainstPriors(proposed, priors, classifierOptions);
}

function decisionShape(result) {
  return {
    decision: result.decision,
    kind: result.kind || null,
    matchedStatus: result.matchedStatus || null,
    denialReason: result.denialReason || null
  };
}

function deterministicShuffle(values, seed) {
  const copy = values.slice();
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function unrelatedCandidates(count, startIndex = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const token = scenarioToken(startIndex + offset);
    return candidate(
      'fixture-unrelated-' + token,
      offset % 2 === 0 ? 'denied' : 'archived',
      unrelatedExperiment(token),
      {
        denial_reason: 'generated unrelated denial ' + token,
        updated_at: '2026-01-01T00:' + String(offset).padStart(2, '0') + ':00.000Z'
      }
    );
  });
}

// 1. Empty prior history allows a valid proposal.
{
  const root = tempRoot('empty');
  const history = loadHistory(root);
  assert.deepEqual(history, []);
  assert.equal(classify(experiment('emptybase'), history).decision, 'allow');
}

// 2. Any number of unrelated candidates does not block the proposal.
{
  const root = tempRoot('unrelated');
  for (const item of unrelatedCandidates(25, 10)) writeCandidate(root, item);
  const history = loadHistory(root);
  assert.equal(history.length, 25);
  assert.equal(classify(experiment('primaryalpha'), history).decision, 'allow');
}

const baseToken = 'primaryalpha';
const baseProposal = experiment(baseToken);
const occupiedStatus = occupiedStatuses[0];
const occupiedManifest = candidate(
  'fixture-occupied-primary',
  occupiedStatus,
  baseProposal,
  { updated_at: '2026-02-01T00:00:00.000Z' }
);
const deniedManifest = candidate(
  'fixture-denied-primary',
  'denied',
  baseProposal,
  {
    denial_reason: 'generated denial context for primary scenario',
    updated_at: '2026-01-31T00:00:00.000Z'
  }
);

// 3. Adding one materially similar occupied candidate changes result to occupied duplicate.
{
  const root = tempRoot('occupied');
  writeCandidate(root, occupiedManifest);
  const history = loadHistory(root);
  const result = classify(baseProposal, history);
  assert.equal(result.decision, 'reject');
  assert.equal(result.kind, 'duplicate_occupied');
  assert.equal(result.matchedStatus, occupiedStatus);
}

// 4-6. Removing occupied restores prior result; denied revises until occupied appears.
{
  const deniedOnly = [deniedManifest];
  const deniedResult = classify(baseProposal, deniedOnly);
  assert.equal(deniedResult.decision, 'revise');
  assert.equal(deniedResult.kind, 'denied_repeat');
  assert.equal(deniedResult.denialReason, deniedManifest.denial_reason);

  const withOccupied = [deniedManifest, occupiedManifest];
  const occupiedResult = classify(baseProposal, withOccupied);
  assert.equal(occupiedResult.decision, 'reject');
  assert.equal(occupiedResult.kind, 'duplicate_occupied');

  assert.deepEqual(decisionShape(classify(baseProposal, deniedOnly)), decisionShape(deniedResult));
}

// 7-8. Candidate ordering, reversal, and generated shuffles do not affect outcome.
{
  const candidates = unrelatedCandidates(12, 100).concat([deniedManifest, occupiedManifest]);
  const expected = decisionShape(classify(baseProposal, candidates));
  assert.equal(expected.decision, 'reject');
  assert.deepEqual(decisionShape(classify(baseProposal, candidates.slice().reverse())), expected);
  for (let seed = 1; seed <= 12; seed += 1) {
    assert.deepEqual(decisionShape(classify(baseProposal, deterministicShuffle(candidates, seed))), expected);
  }
}

// 9. Candidate IDs do not affect similarity classification.
{
  const a = candidate('fixture-id-a', occupiedStatus, baseProposal);
  const b = candidate('fixture-id-b', occupiedStatus, baseProposal);
  assert.deepEqual(decisionShape(classify(baseProposal, [a])), decisionShape(classify(baseProposal, [b])));
}

// 10-11. Candidate count and unrelated candidates before/after do not affect classification.
{
  const small = [occupiedManifest];
  const large = unrelatedCandidates(200, 200).slice(0, 100)
    .concat([occupiedManifest])
    .concat(unrelatedCandidates(200, 400).slice(0, 100));
  assert.deepEqual(decisionShape(classify(baseProposal, small)), decisionShape(classify(baseProposal, large)));
}

// 12. One shared broad file alone is insufficient for duplicate classification.
{
  const sharedFile = baseProposal.target_files[0];
  const broadFileOnly = unrelatedExperiment('broadshare', [sharedFile]);
  assert.equal(classify(broadFileOnly, [occupiedManifest]).decision, 'allow');
}

// 13. Exact normalized signature match is rejected for occupied status.
{
  const exact = classify(baseProposal, [occupiedManifest]);
  assert.equal(exact.decision, 'reject');
  assert.equal(exact.kind, 'duplicate_occupied');
}

// 14. High-confidence near duplicate is rejected for occupied status.
{
  const near = classify(nearExperiment(baseToken), [occupiedManifest]);
  assert.equal(near.decision, 'reject');
  assert.equal(near.kind, 'duplicate_occupied');
}

// 15. A materially different proposal is allowed.
{
  assert.equal(classify(revisedExperiment('differentbeta'), [occupiedManifest]).decision, 'allow');
}

// 16. Denied revision guidance includes denial context and diff.
{
  const root = tempRoot('denied-context');
  writeCandidate(root, deniedManifest);
  const history = loadHistory(root);
  const result = classify(baseProposal, history);
  assert.equal(result.decision, 'revise');
  assert.equal(result.denialReason, deniedManifest.denial_reason);
  assert.match(result.changesDiff, /diff --git/);
}

// 17. A materially revised denied proposal may proceed.
{
  assert.equal(classify(revisedExperiment(baseToken), [deniedManifest]).decision, 'allow');
}

// 18-19. Missing/malformed optional fields and empty candidate directories are valid.
{
  const root = tempRoot('malformed-optional');
  writeCandidate(root, candidate(
    'fixture-empty-directory',
    'denied',
    unrelatedExperiment('emptydir')
  ), { emptyOnly: true });
  writeCandidate(root, candidate(
    'fixture-optional-fields',
    'denied',
    unrelatedExperiment('optionalfields'),
    {
      experiment: null,
      changed_files: null,
      denial_reason: null
    }
  ));
  fs.mkdirSync(path.join(root, 'fixture-invalid-json'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'fixture-invalid-json', 'manifest.json'), '{not-json\n', { mode: 0o600 });
  const history = loadHistory(root);
  assert.equal(history.length, 1);
  assert.equal(classify(baseProposal, history).decision, 'allow');
}

// 20. Arbitrarily large fixture histories preserve the same decision rule.
{
  const large = unrelatedCandidates(500, 700);
  large.splice(321, 0, occupiedManifest);
  const result = classify(baseProposal, large);
  assert.equal(result.decision, 'reject');
  assert.equal(result.kind, 'duplicate_occupied');
}

// 21. Occupied statuses come from loaded YAML policy.
for (const status of occupiedStatuses) {
  assert.equal(isOccupiedStatus(status, classifierOptions), true);
}
assert.equal(isOccupiedStatus('denied', classifierOptions), false);

// 22. The generated fixture never reads or requires real candidate contents.
assert.equal(fs.existsSync(path.join(productionConfig.candidate_root, occupiedManifest.id)), false);

// 23. Production behavior is candidate-agnostic: changing IDs and generated
// objective tokens changes only the synthetic inputs, not the decision rule.
{
  const leftToken = 'leftgamma';
  const rightToken = 'rightdelta';
  const left = candidate('fixture-left-id', occupiedStatus, experiment(leftToken));
  const right = candidate('fixture-right-id', occupiedStatus, experiment(rightToken));
  assert.equal(classify(experiment(leftToken), [left, right]).decision, 'reject');
  assert.equal(classify(experiment(rightToken), [left, right]).decision, 'reject');
  assert.equal(classify(revisedExperiment('unmatchedtheta'), [left, right]).decision, 'allow');
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_CANDIDATE_DEDUP_CONTRACT_PASS',
  isolated_fixtures: true,
  occupied_statuses: occupiedStatuses,
  yaml_similarity_policy: policy,
  order_independent: true,
  candidate_count_independent: true,
  candidate_id_independent: true,
  real_candidate_state_required: false,
  real_candidate_state_mutated: false
}, null, 2));
