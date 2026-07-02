'use strict';

// Autonomous goal formation for the RSI harness.
//
// At the start of a cycle Floki generates multiple self-chosen goals; each goal
// records the full required provenance. Floki selects one. The controller may
// reject a selected goal ONLY for the enumerated safety/proof/authority reasons
// — it never suppresses Floki's ability to investigate or experiment. A Maker
// objective overrides free selection; an empty objective means Floki chooses.

const crypto = require('node:crypto');
const { loadSelfImprovementConfig } = require('./config.cjs');

// Every goal proposal must carry these fields (provenance + decision signals).
const REQUIRED_GOAL_FIELDS = Object.freeze([
  'desire',
  'personal_reason',
  'originating_experiences',
  'belief_value_relevance',
  'runtime_or_source_evidence',
  'expected_capability_change',
  'novelty',
  'personal_relevance',
  'technical_value',
  'feasibility',
  'risk',
  'measurable_success_criteria'
]);

// The controller's rejection vocabulary is closed: these are the ONLY reasons it
// may reject a Floki-selected goal.
const REJECTION_REASONS = Object.freeze([
  'unsafe',
  'impossible_to_verify',
  'outside_sandbox_authority',
  'unchanged_duplicate_of_denied',
  'already_active_or_queued'
]);

function newGoalId(config) {
  return (
    config.goal_id_prefix +
    '-' +
    new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) +
    '-' +
    crypto.randomBytes(3).toString('hex')
  );
}

function createGoalRecord(input, config = loadSelfImprovementConfig()) {
  if (!input || typeof input !== 'object') throw new Error('goal input must be an object');
  const missing = REQUIRED_GOAL_FIELDS.filter((f) => {
    const v = input[f];
    if (f === 'originating_experiences') return !Array.isArray(v) || v.length === 0;
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
  if (missing.length > 0) {
    throw new Error('goal is missing required fields: ' + missing.join(', '));
  }
  const objective = String(input.objective || input.desire).slice(0, config.goal_objective_max_chars);
  return Object.freeze({
    goal_id: input.goal_id || newGoalId(config),
    objective,
    desire: String(input.desire).slice(0, config.goal_reason_max_chars),
    personal_reason: String(input.personal_reason).slice(0, config.goal_reason_max_chars),
    originating_experiences: Object.freeze([...input.originating_experiences]),
    belief_value_relevance: String(input.belief_value_relevance).slice(0, config.goal_reason_max_chars),
    runtime_or_source_evidence: String(input.runtime_or_source_evidence).slice(0, config.goal_reason_max_chars),
    research_evidence: input.research_evidence ? String(input.research_evidence).slice(0, config.goal_reason_max_chars) : null,
    expected_capability_change: String(input.expected_capability_change).slice(0, config.goal_reason_max_chars),
    novelty: input.novelty,
    personal_relevance: input.personal_relevance,
    technical_value: input.technical_value,
    feasibility: input.feasibility,
    risk: input.risk,
    measurable_success_criteria: input.measurable_success_criteria,
    requires_host_access: input.requires_host_access === true,
    target_paths: Object.freeze(Array.isArray(input.target_paths) ? [...input.target_paths] : []),
    patch_sha256: input.patch_sha256 || null,
    source: 'floki_selected'
  });
}

function validateGoalSet(goals, config = loadSelfImprovementConfig()) {
  if (!Array.isArray(goals)) throw new Error('goals must be an array');
  if (goals.length < config.goal_min_proposals) {
    throw new Error('too few goal proposals: ' + goals.length + ' < ' + config.goal_min_proposals);
  }
  if (goals.length > config.goal_max_proposals) {
    throw new Error('too many goal proposals: ' + goals.length + ' > ' + config.goal_max_proposals);
  }
  const ids = new Set();
  for (const g of goals) {
    if (ids.has(g.goal_id)) throw new Error('duplicate goal_id: ' + g.goal_id);
    ids.add(g.goal_id);
  }
  return true;
}

function selectGoal(goals, goalId) {
  const goal = goals.find((g) => g.goal_id === goalId);
  if (!goal) throw new Error('selected goal not found: ' + goalId);
  return goal;
}

// Resolve the objective for a cycle. A non-empty Maker objective overrides free
// selection; empty means Floki freely selects his own experiment.
function resolveObjective(makerObjective) {
  const trimmed = typeof makerObjective === 'string' ? makerObjective.trim() : '';
  if (trimmed) return Object.freeze({ objective: trimmed, source: 'maker_requested', floki_free_selection: false });
  return Object.freeze({ objective: '', source: 'floki_selected', floki_free_selection: true });
}

function objectiveOverlapScore(a, b) {
  const wa = new Set(String(a || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(String(b || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared;
}

// Controller review at the sandbox/production boundary. Returns an accepted goal
// or a single enumerated rejection reason. Context provides protected prefixes,
// the denial comparator, and the active/queued candidate objectives.
function controllerReview(goal, context = {}, config = loadSelfImprovementConfig()) {
  const protectedPrefixes = Array.isArray(context.protected_path_prefixes) ? context.protected_path_prefixes : [];
  const activeObjectives = Array.isArray(context.active_or_queued_objectives) ? context.active_or_queued_objectives : [];
  const minOverlap = config.denial_eval_min_objective_overlap;

  // unsafe: explicit unacceptable risk, requested unsafe op, or targeting a
  // protected path from inside the candidate.
  if (goal.risk === 'unacceptable' || goal.unsafe === true) {
    return reject('unsafe', 'goal declares unacceptable risk');
  }
  for (const target of goal.target_paths) {
    if (protectedPrefixes.some((p) => target === p || target.startsWith(p))) {
      return reject('unsafe', 'goal targets a protected path: ' + target);
    }
  }

  // outside_sandbox_authority: requires host access / out-of-sandbox actions.
  if (goal.requires_host_access === true) {
    return reject('outside_sandbox_authority', 'goal requires host access outside the sandbox');
  }

  // impossible_to_verify: no measurable success criteria.
  const criteria = goal.measurable_success_criteria;
  const hasCriteria = Array.isArray(criteria) ? criteria.length > 0 : Boolean(criteria && String(criteria).trim());
  if (!hasCriteria) {
    return reject('impossible_to_verify', 'goal has no measurable success criteria');
  }

  // unchanged_duplicate_of_denied: identical to denied work.
  if (typeof context.compare_to_denial === 'function') {
    const cmp = context.compare_to_denial({ objective: goal.objective, patch_sha256: goal.patch_sha256 });
    if (cmp && cmp.is_unchanged_duplicate) {
      return reject('unchanged_duplicate_of_denied', 'goal is an unchanged duplicate of denied work');
    }
  }

  // already_active_or_queued: same objective already represented.
  for (const obj of activeObjectives) {
    if (objectiveOverlapScore(goal.objective, obj) >= Math.max(minOverlap, 4)) {
      return reject('already_active_or_queued', 'goal duplicates an active or queued candidate');
    }
  }

  return Object.freeze({ accepted: true, goal_id: goal.goal_id, rejection_reason: null });
}

function reject(reason, detail) {
  if (!REJECTION_REASONS.includes(reason)) throw new Error('illegal rejection reason: ' + reason);
  return Object.freeze({ accepted: false, rejection_reason: reason, detail });
}

module.exports = {
  REQUIRED_GOAL_FIELDS,
  REJECTION_REASONS,
  newGoalId,
  createGoalRecord,
  validateGoalSet,
  selectGoal,
  resolveObjective,
  controllerReview,
  objectiveOverlapScore
};
