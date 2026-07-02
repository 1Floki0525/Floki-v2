'use strict';

// Contract: an actionable denial converts to a durable regression eval, persists,
// and applies to a future goal/candidate with sufficient objective overlap.
// Non-actionable denials produce no eval. Exercises real functions (no mocks).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const de = require('../src/self-improvement/denial-eval.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

// Use an isolated eval root so the test never touches real state.
const base = loadSelfImprovementConfig();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-deval-'));
const config = Object.assign({}, base, { denial_eval_root: tmpRoot });

try {
  // --- non-actionable denial yields no eval ---
  assert.equal(de.isActionableDenial({ id: 'c1', objective: 'x' }), false);
  assert.equal(de.denialToEval({ id: 'c1', objective: 'x' }, config), null);

  // --- actionable denial converts to a regression eval ---
  const denial = {
    id: 'cand-2026-01',
    objective: 'Add a heuristic so the investigator prefers find_callers before broad search',
    denial_reason: 'No focused behavioral test proving fewer search turns; add a measurable assertion',
    patch_sha256: 'abc123'
  };
  const spec = de.denialToEval(denial, config);
  assert.ok(spec, 'eval produced for actionable denial');
  assert.equal(spec.marker, 'FLOKI_V2_RSI_DENIAL_EVAL');
  assert.equal(spec.source_denial_id, 'cand-2026-01');
  assert.ok(spec.assertion.includes('focused behavioral test'), 'assertion derived from denial reason');
  assert.equal(spec.min_objective_overlap, config.denial_eval_min_objective_overlap);

  // --- persists and lists ---
  const file = de.persistEval(spec, config);
  assert.ok(fs.existsSync(file), 'eval persisted');
  const listed = de.listDenialEvals(config);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, spec.id);

  // deterministic id (idempotent persist)
  const spec2 = de.denialToEval(denial, config);
  assert.equal(spec2.id, spec.id, 'eval id deterministic for same denial');
  de.persistEval(spec2, config);
  assert.equal(de.listDenialEvals(config).length, 1, 'idempotent persist');

  // --- applicability by objective overlap ---
  const related = 'Improve the investigator heuristic to prefer find_callers over broad search turns';
  const unrelated = 'Adjust the webcam exposure brightness curve for low light';
  assert.ok(de.applicableEvals(related, config).length >= 1, 'eval applies to overlapping objective');
  assert.equal(de.applicableEvals(unrelated, config).length, 0, 'eval does not apply to unrelated objective');
} finally {
  fs.rmSync(tmpRoot, { recursive: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_DENIAL_EVAL_PASS',
  actionable_only: true,
  persisted: true,
  idempotent: true,
  applicability_by_overlap: true
}, null, 2));
