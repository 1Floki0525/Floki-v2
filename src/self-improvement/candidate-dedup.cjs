'use strict';

// Candidate occupancy + similarity classification for RSI experiment selection.
//
// Imported by BOTH the in-sandbox agent (containers/self-improvement/agent.cjs)
// and its contract tests, so the production selection boundary and the tests
// exercise the SAME logic. This is the real production helper — not a test-only
// reproduction.
//
// Problem it solves: regular RSI repeatedly re-selected the same experiment
// because the selector only consulted denied candidates and read dedup fields
// from the wrong manifest nesting. This module evaluates the actual experiment
// content (objective, hypothesis, target files, focused test) against the full
// prior-candidate history and decides whether the new work is a duplicate of
// occupied (in-flight) work, a revision of denied work, or genuinely new.

function configuredOccupiedStatuses(options = {}) {
  const raw = options.occupied_statuses || options.occupied_candidate_statuses;
  const statuses = Array.isArray(raw)
    ? raw
    : String(raw || '').split('|');
  return Object.freeze(
    statuses
      .map((status) => String(status || '').trim())
      .filter(Boolean)
  );
}

function isOccupiedStatus(status, options = {}) {
  return configuredOccupiedStatuses(options).includes(String(status || ''));
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value, minLen = 4) {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((word) => word.length > minLen)
  );
}

// Token overlap normalized by the smaller set (shared / min(|a|,|b|)). Same
// shape as the agent's original objectiveSimilarityScore so prior tuned
// thresholds keep their meaning.
function similarity(a, b) {
  const wa = tokenSet(a);
  const wb = tokenSet(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

function normalizeFile(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function fileSet(files) {
  return new Set(
    (Array.isArray(files) ? files : [])
      .map(normalizeFile)
      .filter(Boolean)
  );
}

function fileOverlapRatio(a, b) {
  const sa = a instanceof Set ? a : fileSet(a);
  const sb = b instanceof Set ? b : fileSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const file of sa) if (sb.has(file)) shared += 1;
  return shared / Math.min(sa.size, sb.size);
}

function loadDefaultSimilarityOptions() {
  try {
    return require('./config.cjs').loadSelfImprovementConfig();
  } catch (error) {
    throw new Error('candidate dedup similarity policy requires YAML-derived config: ' + error.message);
  }
}

function numericPolicy(options, key) {
  const source = options && Number.isFinite(Number(options[key]))
    ? options
    : loadDefaultSimilarityOptions();
  const value = Number(source[key]);
  if (!Number.isFinite(value)) {
    throw new Error('candidate dedup similarity policy missing numeric YAML key: ' + key);
  }
  return value;
}

function similarityPolicy(options = {}) {
  return Object.freeze({
    strongObjective: numericPolicy(options, 'candidate_dedup_strong_objective_similarity_min'),
    strongHypothesis: numericPolicy(options, 'candidate_dedup_strong_hypothesis_similarity_min'),
    focusedObjective: numericPolicy(options, 'candidate_dedup_focused_test_objective_similarity_min'),
    focusedFileOverlap: numericPolicy(options, 'candidate_dedup_focused_test_file_overlap_min'),
    focusedText: numericPolicy(options, 'candidate_dedup_focused_test_text_similarity_min'),
    moderateObjective: numericPolicy(options, 'candidate_dedup_moderate_objective_similarity_min'),
    moderateHypothesis: numericPolicy(options, 'candidate_dedup_moderate_hypothesis_similarity_min'),
    highFileOverlap: numericPolicy(options, 'candidate_dedup_high_file_overlap_min')
  });
}

// Normalize one experiment-like object into comparable fields. Tolerates both
// shapes the codebase produces:
//   - flat select_experiment args: { objective, hypothesis, target_files, focused_test }
//   - candidate manifest: { objective, experiment: { hypothesis, target_files, focused_test }, changed_files }
// so the classifier is correct even if an upstream producer regresses the
// field nesting again.
function normalizeExperiment(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const experiment = source.experiment && typeof source.experiment === 'object'
    ? source.experiment
    : {};

  const objective = experiment.objective != null ? experiment.objective : source.objective;
  const hypothesis = experiment.hypothesis != null ? experiment.hypothesis : source.hypothesis;

  let targetFiles = [];
  if (Array.isArray(source.target_files) && source.target_files.length > 0) {
    targetFiles = source.target_files;
  } else if (Array.isArray(experiment.target_files) && experiment.target_files.length > 0) {
    targetFiles = experiment.target_files;
  } else if (Array.isArray(source.changed_files) && source.changed_files.length > 0) {
    targetFiles = source.changed_files;
  }

  const focusedTest = experiment.focused_test != null ? experiment.focused_test : source.focused_test;

  return {
    id: source.id != null ? String(source.id) : null,
    status: source.status != null ? String(source.status) : null,
    candidate_type: source.candidate_type != null ? String(source.candidate_type) : null,
    objective: normalizeText(objective),
    objective_raw: objective == null ? '' : String(objective),
    hypothesis: normalizeText(hypothesis),
    hypothesis_raw: hypothesis == null ? '' : String(hypothesis),
    target_files: fileSet(targetFiles),
    focused_test: normalizeText(focusedTest),
    denial_reason: source.denial_reason != null ? String(source.denial_reason) : null,
    changes_diff: source.changes_diff != null ? String(source.changes_diff) : null,
    created_at: source.created_at != null ? String(source.created_at) : null,
    updated_at: source.updated_at != null ? String(source.updated_at) : null
  };
}

// Exact signature: every comparable field is identical after normalization.
function isExactSignatureMatch(a, b) {
  return (
    a.objective.length > 0 &&
    a.objective === b.objective &&
    a.hypothesis === b.hypothesis &&
    a.focused_test === b.focused_test &&
    a.target_files.size === b.target_files.size &&
    fileOverlapRatio(a.target_files, b.target_files) === 1
  );
}

// High-confidence near-duplicate. Requires at least TWO independent strong
// signals so unrelated work that merely shares one broad file is NOT merged.
function duplicateMatch(a, b, options = {}) {
  const policy = similarityPolicy(options);
  const objSim = similarity(a.objective_raw, b.objective_raw);
  const hypSim = similarity(a.hypothesis_raw, b.hypothesis_raw);
  const fileOverlap = fileOverlapRatio(a.target_files, b.target_files);
  const sameFocusedTest = a.focused_test.length > 0 && a.focused_test === b.focused_test;
  const exact = isExactSignatureMatch(a, b);

  let matched = exact;
  if (!matched && objSim >= policy.strongObjective && hypSim >= policy.strongHypothesis) matched = true;
  if (!matched && objSim >= policy.focusedObjective && sameFocusedTest) matched = true;
  if (
    !matched &&
    sameFocusedTest &&
    fileOverlap >= policy.focusedFileOverlap &&
    (objSim >= policy.focusedText || hypSim >= policy.focusedText)
  ) {
    matched = true;
  }
  if (
    !matched &&
    objSim >= policy.moderateObjective &&
    hypSim >= policy.moderateHypothesis &&
    fileOverlap >= policy.highFileOverlap
  ) {
    matched = true;
  }

  return Object.freeze({
    matched,
    exact,
    score:
      (exact ? 10 : 0) +
      objSim +
      hypSim +
      fileOverlap +
      (sameFocusedTest ? 1 : 0),
    objective_similarity: objSim,
    hypothesis_similarity: hypSim,
    file_overlap: fileOverlap,
    same_focused_test: sameFocusedTest
  });
}

function isNearDuplicate(a, b, options = {}) {
  const match = duplicateMatch(a, b, options);
  return match.matched && !match.exact;
}

function materiallyDuplicates(a, b, options = {}) {
  return duplicateMatch(a, b, options).matched;
}

function stableTieKey(prior) {
  return [
    String(prior.updated_at || ''),
    String(prior.created_at || ''),
    String(prior.id || '')
  ].join('\u0000');
}

function strongestMatch(matches) {
  if (!matches.length) return null;
  return matches.slice().sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    return stableTieKey(b.prior).localeCompare(stableTieKey(a.prior));
  })[0];
}

// Classify a proposed experiment against prior candidate history.
//
//   proposed: select_experiment args (or any experiment-like object)
//   priors:   array of candidate-history entries (manifest-ish or normalized)
//
// Returns exactly one of:
//   { decision: 'reject', kind: 'duplicate_occupied', matchedId, matchedStatus, reason }
//   { decision: 'revise', kind: 'denied_repeat', matchedId, denialReason, changesDiff, reason }
//   { decision: 'allow' }
//
// 'reject' is enforced at the production selection boundary even if the model
// ignored the prompt. 'revise' preserves the ability to revisit denied work.
function classifyExperimentAgainstPriors(proposed, priors, options = {}) {
  const norm = normalizeExperiment(proposed);
  if (norm.objective.length === 0) return { decision: 'allow' };
  const occupiedStatuses = configuredOccupiedStatuses(options);

  const normalized = (Array.isArray(priors) ? priors : []).map(normalizeExperiment);

  // 1) Reject duplicates of OCCUPIED (in-flight) work. This is deliberately a
  // full scan: a denied match must never preempt an occupied match that appears
  // later in candidate history.
  const occupiedMatch = strongestMatch(normalized
    .filter((prior) => occupiedStatuses.includes(String(prior.status || '')))
    .map((prior) => ({ prior, match: duplicateMatch(norm, prior, options) }))
    .filter((entry) => entry.match.matched));
  if (occupiedMatch) {
    const prior = occupiedMatch.prior;
    return {
      decision: 'reject',
      kind: 'duplicate_occupied',
      matchedId: prior.id,
      matchedStatus: prior.status,
      reason:
        'This experiment materially duplicates candidate ' +
        (prior.id || '(unknown)') + ', which is already ' + prior.status +
        ' (occupied work awaiting the Maker review boundary). ' +
        'Select a materially different objective, hypothesis, target files, ' +
        'or focused test — do not resubmit work that is already in flight.'
    };
  }

  // 2) Denied candidates -> revisable with a revision constraint, never a
  //    permanent block on the whole technical subject.
  const deniedMatch = strongestMatch(normalized
    .filter((prior) => prior.status === 'denied')
    .map((prior) => ({ prior, match: duplicateMatch(norm, prior, options) }))
    .filter((entry) => entry.match.matched));
  if (deniedMatch) {
    const prior = deniedMatch.prior;
    return {
      decision: 'revise',
      kind: 'denied_repeat',
      matchedId: prior.id,
      denialReason: prior.denial_reason,
      changesDiff: prior.changes_diff,
      reason:
        'This experiment closely matches Maker-denied candidate ' +
        (prior.id || '(unknown)') + '. You may revise it, but you must ' +
        'address the denial reason and change the approach — not merely rephrase.'
    };
  }

  return { decision: 'allow' };
}

function validateDeniedRevisionPlan(classification, proposed = {}) {
  if (!classification || classification.decision !== 'revise') {
    return Object.freeze({ ok: true, plan: null });
  }
  const plan = proposed.denial_revision_plan;
  const required = [
    'denial_requirement',
    'implementation_change',
    'focused_test_change'
  ];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return Object.freeze({
      ok: false,
      reason:
        'A proposal that revisits denied work must include denial_revision_plan ' +
        'with denial_requirement, implementation_change, and focused_test_change.'
    });
  }
  const normalized = {};
  for (const key of required) {
    const value = typeof plan[key] === 'string' ? plan[key].trim() : '';
    if (!value) {
      return Object.freeze({
        ok: false,
        reason:
          'denial_revision_plan.' + key +
          ' is required when revising denied work.'
      });
    }
    normalized[key] = value;
  }
  return Object.freeze({
    ok: true,
    plan: Object.freeze(normalized),
    matchedId: classification.matchedId || null,
    denialReason: classification.denialReason || null
  });
}

module.exports = {
  configuredOccupiedStatuses,
  isOccupiedStatus,
  normalizeText,
  tokenSet,
  similarity,
  normalizeFile,
  fileSet,
  fileOverlapRatio,
  similarityPolicy,
  duplicateMatch,
  normalizeExperiment,
  isExactSignatureMatch,
  isNearDuplicate,
  materiallyDuplicates,
  classifyExperimentAgainstPriors,
  validateDeniedRevisionPlan
};
