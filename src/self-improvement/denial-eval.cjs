'use strict';

// Denial-to-eval conversion for the RSI harness.
//
// Every actionable denial should yield a durable regression eval so future
// candidates in the same area must satisfy it. Evals are persisted under a
// configured (gitignored) root and are matched to a goal/candidate objective by
// bounded overlap. All limits originate in chat YAML.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadSelfImprovementConfig } = require('./config.cjs');

function evalRoot(config) {
  return config.denial_eval_root.startsWith('/')
    ? config.denial_eval_root
    : path.resolve(config.project_root, config.denial_eval_root);
}

function newEvalId(config, denial) {
  const basis = (denial && (denial.id || denial.objective || '')) + '|' + (denial && denial.denial_reason ? denial.denial_reason : '');
  const hash = crypto.createHash('sha256').update(basis).digest('hex').slice(0, 10);
  return config.denial_eval_id_prefix + '-' + hash;
}

function objectiveOverlap(a, b) {
  const wa = new Set(String(a || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wb = new Set(String(b || '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared;
}

// A denial is actionable when it carries a concrete reason; only actionable
// denials become regression evals.
function isActionableDenial(denial) {
  if (!denial || typeof denial !== 'object') return false;
  const reason = denial.denial_reason || denial.deny_reason || '';
  return typeof reason === 'string' && reason.trim().length > 0;
}

function denialToEval(denial, config = loadSelfImprovementConfig()) {
  if (!isActionableDenial(denial)) return null;
  const reason = (denial.denial_reason || denial.deny_reason || '').trim();
  return Object.freeze({
    marker: 'FLOKI_V2_RSI_DENIAL_EVAL',
    schema_version: 1,
    id: newEvalId(config, denial),
    source_denial_id: denial.id || null,
    objective: denial.objective ? String(denial.objective).slice(0, config.goal_objective_max_chars) : '',
    denial_reason: reason,
    assertion: 'A future candidate addressing this objective must demonstrably resolve: ' + reason,
    min_objective_overlap: config.denial_eval_min_objective_overlap,
    patch_sha256: denial.patch_sha256 || null,
    created_at: new Date().toISOString(),
    actionable: true
  });
}

function persistEval(evalSpec, config = loadSelfImprovementConfig()) {
  if (!evalSpec) return null;
  const root = evalRoot(config);
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, evalSpec.id + '.json');
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(evalSpec, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function listDenialEvals(config = loadSelfImprovementConfig()) {
  const root = evalRoot(config);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
    } catch {
      // skip malformed eval file
    }
  }
  return out;
}

// Which persisted evals apply to a candidate/goal objective.
function applicableEvals(objective, config = loadSelfImprovementConfig()) {
  const evals = listDenialEvals(config);
  return evals.filter((e) => objectiveOverlap(objective, e.objective) >= (e.min_objective_overlap || config.denial_eval_min_objective_overlap));
}

module.exports = {
  isActionableDenial,
  denialToEval,
  persistEval,
  listDenialEvals,
  applicableEvals,
  objectiveOverlap,
  evalRoot,
  newEvalId
};
