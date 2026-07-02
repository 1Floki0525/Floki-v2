'use strict';

// Run kinds and candidate types for the RSI harness.
//
// The RSI lab supports explicit run kinds (default "code" for normal autonomous
// coding sandboxes, and "training" for QLoRA training runs). Each run kind maps
// to a candidate type; the existing code-patch promoter must refuse training
// (model_adapter) candidates. All values originate in chat YAML.

const { loadSelfImprovementConfig } = require('./config.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function parseKeyValuePipes(value) {
  const map = {};
  for (const pair of splitPipeList(value)) {
    const [k, v] = pair.split('=');
    if (k && v) map[k.trim()] = v.trim();
  }
  return map;
}

function loadRunKinds(config = loadSelfImprovementConfig()) {
  const allowed = splitPipeList(config.allowed_rsi_run_kinds);
  if (allowed.length === 0) throw new Error('allowed_rsi_run_kinds is empty');
  const def = config.default_rsi_run_kind;
  if (!allowed.includes(def)) throw new Error('default_rsi_run_kind not in allowed list: ' + def);
  const candidateTypes = parseKeyValuePipes(config.rsi_run_kind_candidate_types);
  for (const kind of allowed) {
    if (!candidateTypes[kind]) throw new Error('no candidate type mapped for run kind: ' + kind);
  }
  const promoterAccepts = splitPipeList(config.code_patch_promoter_accepted_candidate_types);
  return Object.freeze({
    allowed: Object.freeze([...allowed]),
    default: def,
    candidate_types: Object.freeze({ ...candidateTypes }),
    code_patch_promoter_accepts: Object.freeze([...promoterAccepts])
  });
}

// Normalize a requested run kind: empty/undefined => default; an explicit but
// unknown kind is an error (the controller must not silently coerce).
function normalizeRunKind(kind, config = loadSelfImprovementConfig()) {
  const kinds = loadRunKinds(config);
  if (kind === undefined || kind === null || (typeof kind === 'string' && kind.trim() === '')) {
    return kinds.default;
  }
  const value = String(kind).trim();
  if (!kinds.allowed.includes(value)) {
    throw new Error('unknown RSI run kind: ' + value + ' (allowed: ' + kinds.allowed.join(', ') + ')');
  }
  return value;
}

function candidateTypeForKind(kind, config = loadSelfImprovementConfig()) {
  const kinds = loadRunKinds(config);
  const normalized = normalizeRunKind(kind, config);
  return kinds.candidate_types[normalized];
}

function isTrainingKind(kind, config = loadSelfImprovementConfig()) {
  return normalizeRunKind(kind, config) === 'training';
}

function promoterAcceptsCandidateType(candidateType, config = loadSelfImprovementConfig()) {
  const kinds = loadRunKinds(config);
  return kinds.code_patch_promoter_accepts.includes(String(candidateType));
}

// Used by the code-patch promoter to refuse model_adapter (training) candidates.
function assertCodePatchPromoterAccepts(candidateType, config = loadSelfImprovementConfig()) {
  if (!promoterAcceptsCandidateType(candidateType, config)) {
    throw new Error(
      'code-patch promoter refuses candidate type "' + candidateType +
      '"; training/model_adapter candidates require the adapter evaluation/promotion path'
    );
  }
  return true;
}

module.exports = {
  loadRunKinds,
  normalizeRunKind,
  candidateTypeForKind,
  isTrainingKind,
  promoterAcceptsCandidateType,
  assertCodePatchPromoterAccepts,
  splitPipeList
};
