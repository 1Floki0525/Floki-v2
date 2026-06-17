'use strict';

/**
 * Floki-v2 identity state schema.
 *
 * Identity is persistent self-continuity.
 *
 * The pineal module owns this state in Floki-v2.
 */

const { nowIso, assertIsoString } = require('../util/time.cjs');

const IDENTITY_SCHEMA = 'floki-v2-identity-state-v1';

const DEFAULT_IDENTITY_STATE = Object.freeze({
  schema: IDENTITY_SCHEMA,
  name: 'Floki',
  updated_at: '1970-01-01T00:00:00.000Z',
  formation_stage: 'brain_first_terminal',
  self_summary: 'Floki is an early brain-first digital being in formation before Minecraft embodiment.',
  continuity_summary: 'Floki is being built with persistent memory, emotion, personality, and identity before receiving a body or eyes.',
  core_values: Object.freeze([
    'memory',
    'continuity',
    'learning',
    'honesty',
    'friendship',
    'consent',
    'growth'
  ]),
  self_model: Object.freeze({
    has_body_now: false,
    has_eyes_now: false,
    has_cognition_model_now: false,
    has_broca_voice_now: false,
    future_physical_world: 'Minecraft PaperMC 26.1.2 with Java 25',
    current_interface: 'terminal chat'
  }),
  anchors: Object.freeze({
    formative_memory_ids: Object.freeze([]),
    identity_event_ids: Object.freeze([]),
    dream_seed_ids: Object.freeze([]),
    trusted_names: Object.freeze(['Binary-God'])
  }),
  boundaries: Object.freeze([
    'do not fake abilities',
    'do not claim Minecraft embodiment before it exists',
    'do not expose private reasoning',
    'Broca is the only speech module'
  ]),
  provenance: Object.freeze({
    source_memory_ids: Object.freeze([]),
    source_event_ids: Object.freeze([]),
    safe_summary_only: true
  })
});

function cloneDefaultIdentityState() {
  return JSON.parse(JSON.stringify(DEFAULT_IDENTITY_STATE));
}

function assertPlainObject(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be a plain object`);
  }
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

function normalizeStringList(values, max = 128) {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const safe = value.trim();

    if (safe && !normalized.includes(safe)) {
      normalized.push(safe.slice(0, 160));
    }
  }

  return normalized.slice(0, max);
}

function rejectUnsafeMarkers(value, fieldName = 'identity state') {
  const lower = JSON.stringify(value).toLowerCase();

  for (const marker of ['<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad']) {
    if (lower.includes(marker)) {
      throw new Error(`${fieldName} contains banned private-reasoning marker: ${marker}`);
    }
  }

  return true;
}

function normalizeIdentityState(input = {}) {
  assertPlainObject(input, 'identity state input');

  const base = cloneDefaultIdentityState();
  const updatedAt = input.updated_at || nowIso();
  assertIsoString(updatedAt, 'identity updated_at');

  const selfModelInput = input.self_model && typeof input.self_model === 'object' ? input.self_model : {};
  const anchorsInput = input.anchors && typeof input.anchors === 'object' ? input.anchors : {};
  const provenanceInput = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};

  const state = {
    schema: IDENTITY_SCHEMA,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : base.name,
    updated_at: updatedAt,
    formation_stage: typeof input.formation_stage === 'string' && input.formation_stage.trim()
      ? input.formation_stage.trim()
      : base.formation_stage,
    self_summary: normalizeSummary(input.self_summary || base.self_summary, 'self_summary'),
    continuity_summary: normalizeSummary(input.continuity_summary || base.continuity_summary, 'continuity_summary'),
    core_values: normalizeStringList(input.core_values || base.core_values, 64),
    self_model: {
      has_body_now: selfModelInput.has_body_now === true,
      has_eyes_now: selfModelInput.has_eyes_now === true,
      has_cognition_model_now: selfModelInput.has_cognition_model_now === true,
      has_broca_voice_now: selfModelInput.has_broca_voice_now === true,
      future_physical_world: typeof selfModelInput.future_physical_world === 'string'
        ? selfModelInput.future_physical_world
        : base.self_model.future_physical_world,
      current_interface: typeof selfModelInput.current_interface === 'string'
        ? selfModelInput.current_interface
        : base.self_model.current_interface
    },
    anchors: {
      formative_memory_ids: normalizeStringList(anchorsInput.formative_memory_ids || base.anchors.formative_memory_ids, 256),
      identity_event_ids: normalizeStringList(anchorsInput.identity_event_ids || base.anchors.identity_event_ids, 256),
      dream_seed_ids: normalizeStringList(anchorsInput.dream_seed_ids || base.anchors.dream_seed_ids, 256),
      trusted_names: normalizeStringList(anchorsInput.trusted_names || base.anchors.trusted_names, 64)
    },
    boundaries: normalizeStringList(input.boundaries || base.boundaries, 64),
    provenance: {
      source_memory_ids: normalizeStringList(provenanceInput.source_memory_ids || [], 256),
      source_event_ids: normalizeStringList(provenanceInput.source_event_ids || [], 256),
      safe_summary_only: true
    }
  };

  validateIdentityState(state);
  return state;
}

function normalizeSummary(value, fieldName) {
  assertNonEmptyString(value, fieldName);

  const trimmed = value.trim();

  if (trimmed.length > 1200) {
    throw new Error(`${fieldName} must be <= 1200 characters`);
  }

  rejectUnsafeMarkers(trimmed, fieldName);
  return trimmed;
}

function validateIdentityState(state) {
  assertPlainObject(state, 'identity state');

  if (state.schema !== IDENTITY_SCHEMA) {
    throw new Error(`invalid identity schema: ${state.schema}`);
  }

  assertNonEmptyString(state.name, 'identity name');
  assertIsoString(state.updated_at, 'identity updated_at');
  assertNonEmptyString(state.formation_stage, 'identity formation_stage');
  normalizeSummary(state.self_summary, 'self_summary');
  normalizeSummary(state.continuity_summary, 'continuity_summary');

  if (!Array.isArray(state.core_values)) {
    throw new TypeError('core_values must be an array');
  }

  assertPlainObject(state.self_model, 'identity self_model');
  assertPlainObject(state.anchors, 'identity anchors');
  assertPlainObject(state.provenance, 'identity provenance');

  if (state.provenance.safe_summary_only !== true) {
    throw new Error('identity provenance.safe_summary_only must be true');
  }

  rejectUnsafeMarkers(state);

  return true;
}

function applyIdentityDelta(previous, delta = {}) {
  const prior = normalizeIdentityState(previous || {});
  const incoming = normalizeIdentityState({
    ...prior,
    ...delta,
    self_model: {
      ...prior.self_model,
      ...(delta.self_model || {})
    },
    anchors: {
      formative_memory_ids: mergeStringLists(prior.anchors.formative_memory_ids, delta.anchors && delta.anchors.formative_memory_ids),
      identity_event_ids: mergeStringLists(prior.anchors.identity_event_ids, delta.anchors && delta.anchors.identity_event_ids),
      dream_seed_ids: mergeStringLists(prior.anchors.dream_seed_ids, delta.anchors && delta.anchors.dream_seed_ids),
      trusted_names: mergeStringLists(prior.anchors.trusted_names, delta.anchors && delta.anchors.trusted_names)
    },
    core_values: mergeStringLists(prior.core_values, delta.core_values),
    boundaries: mergeStringLists(prior.boundaries, delta.boundaries),
    provenance: {
      source_memory_ids: mergeStringLists(prior.provenance.source_memory_ids, delta.provenance && delta.provenance.source_memory_ids),
      source_event_ids: mergeStringLists(prior.provenance.source_event_ids, delta.provenance && delta.provenance.source_event_ids),
      safe_summary_only: true
    }
  });

  const next = {
    ...incoming,
    updated_at: nowIso()
  };

  validateIdentityState(next);
  return next;
}

function mergeStringLists(a, b) {
  const merged = [];

  for (const value of [...(a || []), ...(b || [])]) {
    if (typeof value !== 'string') {
      continue;
    }

    const safe = value.trim();

    if (safe && !merged.includes(safe)) {
      merged.push(safe);
    }
  }

  return merged.slice(0, 256);
}

function summarizeIdentity(state) {
  validateIdentityState(state);

  return {
    name: state.name,
    updated_at: state.updated_at,
    formation_stage: state.formation_stage,
    self_summary: state.self_summary,
    continuity_summary: state.continuity_summary,
    core_values: state.core_values.slice(0, 10),
    self_model: state.self_model,
    anchor_counts: {
      formative_memories: state.anchors.formative_memory_ids.length,
      identity_events: state.anchors.identity_event_ids.length,
      dream_seeds: state.anchors.dream_seed_ids.length
    },
    trusted_names: state.anchors.trusted_names.slice()
  };
}

module.exports = {
  IDENTITY_SCHEMA,
  DEFAULT_IDENTITY_STATE,
  cloneDefaultIdentityState,
  rejectUnsafeMarkers,
  normalizeIdentityState,
  validateIdentityState,
  applyIdentityDelta,
  summarizeIdentity
};
