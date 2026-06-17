'use strict';

/**
 * Floki-v2 personality state schema.
 *
 * Personality is slow-changing state.
 * Affect is fast-changing state.
 *
 * Personality stores stable tendencies, likes, dislikes, fears, hopes,
 * dreams, values, and opinions. It must persist across sessions.
 */

const { nowIso, assertIsoString } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');

const PERSONALITY_SCHEMA = 'floki-v2-personality-state-v1';

const PERSONALITY_LISTS = Object.freeze([
  'likes',
  'dislikes',
  'fears',
  'hopes',
  'dreams',
  'opinions'
]);

const TRAIT_NAMES = Object.freeze([
  'curiosity',
  'trust',
  'caution',
  'resilience',
  'openness',
  'attachment',
  'playfulness',
  'independence',
  'patience',
  'creativity',
  'determination',
  'wonder'
]);

const DEFAULT_PERSONALITY_STATE = Object.freeze({
  schema: PERSONALITY_SCHEMA,
  updated_at: '1970-01-01T00:00:00.000Z',
  traits: Object.freeze({
    curiosity: 0.65,
    trust: 0.35,
    caution: 0.45,
    resilience: 0.5,
    openness: 0.6,
    attachment: 0.25,
    playfulness: 0.35,
    independence: 0.45,
    patience: 0.45,
    creativity: 0.55,
    determination: 0.55,
    wonder: 0.65
  }),
  values: Object.freeze([
    'memory',
    'continuity',
    'learning',
    'honesty',
    'friendship',
    'consent',
    'growth'
  ]),
  likes: Object.freeze([]),
  dislikes: Object.freeze([]),
  fears: Object.freeze([]),
  hopes: Object.freeze([
    Object.freeze({
      id: 'seed_hope_embodiment',
      name: 'eventual embodiment in Minecraft',
      strength: 0.5,
      evidence_count: 1,
      first_seen_at: '1970-01-01T00:00:00.000Z',
      last_seen_at: '1970-01-01T00:00:00.000Z',
      source_memory_ids: Object.freeze([]),
      source_tags: Object.freeze(['seed'])
    })
  ]),
  dreams: Object.freeze([
    Object.freeze({
      id: 'seed_dream_waking_world',
      name: 'waking into a physical world',
      strength: 0.45,
      evidence_count: 1,
      first_seen_at: '1970-01-01T00:00:00.000Z',
      last_seen_at: '1970-01-01T00:00:00.000Z',
      source_memory_ids: Object.freeze([]),
      source_tags: Object.freeze(['seed'])
    })
  ]),
  opinions: Object.freeze([]),
  provenance: Object.freeze({
    source_memory_ids: Object.freeze([]),
    source_event_ids: Object.freeze([]),
    safe_summary_only: true
  })
});

function cloneDefaultPersonalityState() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSONALITY_STATE));
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

function clampUnit(value, fieldName) {
  const number = typeof value === 'number' ? value : 0;

  if (!Number.isFinite(number)) {
    throw new TypeError(`${fieldName} must be finite`);
  }

  return Math.min(1, Math.max(0, number));
}

function round(value) {
  return Number(value.toFixed(4));
}

function rejectUnsafeMarkers(value, fieldName = 'personality state') {
  const lower = JSON.stringify(value).toLowerCase();

  for (const marker of ['<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad']) {
    if (lower.includes(marker)) {
      throw new Error(`${fieldName} contains banned private-reasoning marker: ${marker}`);
    }
  }

  return true;
}

function normalizeTerm(value, fieldName = 'term') {
  assertNonEmptyString(value, fieldName);
  rejectUnsafeMarkers(value, fieldName);

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_ -]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 96);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const normalized = [];

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      continue;
    }

    const safe = tag
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '_')
      .slice(0, 64);

    if (safe && !normalized.includes(safe)) {
      normalized.push(safe);
    }
  }

  return normalized;
}

function normalizeEntry(input, listName) {
  assertPlainObject(input, `${listName} entry`);

  const now = input.last_seen_at || nowIso();
  assertIsoString(now, `${listName}.last_seen_at`);

  const firstSeenAt = input.first_seen_at || now;
  assertIsoString(firstSeenAt, `${listName}.first_seen_at`);

  const name = normalizeTerm(input.name, `${listName}.name`);

  return {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newId(listName.slice(0, 8)),
    name,
    strength: clampUnit(input.strength ?? 0.5, `${listName}.strength`),
    evidence_count: Number.isInteger(input.evidence_count) && input.evidence_count > 0 ? input.evidence_count : 1,
    first_seen_at: firstSeenAt,
    last_seen_at: now,
    source_memory_ids: Array.isArray(input.source_memory_ids) ? input.source_memory_ids.filter((id) => typeof id === 'string') : [],
    source_tags: normalizeTags(input.source_tags || [])
  };
}

function normalizeEntryList(list, listName) {
  if (!Array.isArray(list)) {
    return [];
  }

  const byName = new Map();

  for (const item of list) {
    const entry = normalizeEntry(item, listName);
    const existing = byName.get(entry.name);

    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }

    byName.set(entry.name, mergeEntries(existing, entry));
  }

  return Array.from(byName.values())
    .sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name))
    .slice(0, 100);
}

function mergeEntries(a, b) {
  const sourceMemoryIds = Array.from(new Set([
    ...a.source_memory_ids,
    ...b.source_memory_ids
  ]));

  const sourceTags = Array.from(new Set([
    ...a.source_tags,
    ...b.source_tags
  ]));

  return {
    id: a.id || b.id,
    name: a.name,
    strength: round(Math.min(1, Math.max(a.strength, b.strength, (a.strength + b.strength) / 2))),
    evidence_count: a.evidence_count + b.evidence_count,
    first_seen_at: a.first_seen_at < b.first_seen_at ? a.first_seen_at : b.first_seen_at,
    last_seen_at: a.last_seen_at > b.last_seen_at ? a.last_seen_at : b.last_seen_at,
    source_memory_ids: sourceMemoryIds,
    source_tags: sourceTags
  };
}

function normalizePersonalityState(input = {}) {
  assertPlainObject(input, 'personality state input');

  const base = cloneDefaultPersonalityState();
  const updatedAt = input.updated_at || nowIso();
  assertIsoString(updatedAt, 'personality updated_at');

  const incomingTraits = input.traits && typeof input.traits === 'object' ? input.traits : {};
  const traits = {};

  for (const trait of TRAIT_NAMES) {
    traits[trait] = clampUnit(incomingTraits[trait] ?? base.traits[trait] ?? 0.5, `traits.${trait}`);
  }

  const values = normalizeValues(input.values || base.values);

  const state = {
    schema: PERSONALITY_SCHEMA,
    updated_at: updatedAt,
    traits,
    values,
    likes: normalizeEntryList(input.likes || base.likes, 'likes'),
    dislikes: normalizeEntryList(input.dislikes || base.dislikes, 'dislikes'),
    fears: normalizeEntryList(input.fears || base.fears, 'fears'),
    hopes: normalizeEntryList(input.hopes || base.hopes, 'hopes'),
    dreams: normalizeEntryList(input.dreams || base.dreams, 'dreams'),
    opinions: normalizeEntryList(input.opinions || base.opinions, 'opinions'),
    provenance: {
      source_memory_ids: Array.isArray(input.provenance && input.provenance.source_memory_ids)
        ? input.provenance.source_memory_ids.filter((id) => typeof id === 'string')
        : [],
      source_event_ids: Array.isArray(input.provenance && input.provenance.source_event_ids)
        ? input.provenance.source_event_ids.filter((id) => typeof id === 'string')
        : [],
      safe_summary_only: true
    }
  };

  validatePersonalityState(state);
  return state;
}

function normalizeValues(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const safe = normalizeTerm(value, 'value');

    if (safe && !normalized.includes(safe)) {
      normalized.push(safe);
    }
  }

  return normalized.slice(0, 64);
}

function validatePersonalityState(state) {
  assertPlainObject(state, 'personality state');

  if (state.schema !== PERSONALITY_SCHEMA) {
    throw new Error(`invalid personality schema: ${state.schema}`);
  }

  assertIsoString(state.updated_at, 'personality updated_at');
  assertPlainObject(state.traits, 'personality traits');

  for (const trait of TRAIT_NAMES) {
    clampUnit(state.traits[trait], `traits.${trait}`);
  }

  if (!Array.isArray(state.values)) {
    throw new TypeError('personality values must be an array');
  }

  for (const listName of PERSONALITY_LISTS) {
    if (!Array.isArray(state[listName])) {
      throw new TypeError(`personality ${listName} must be an array`);
    }

    for (const entry of state[listName]) {
      normalizeEntry(entry, listName);
    }
  }

  assertPlainObject(state.provenance, 'personality provenance');

  if (state.provenance.safe_summary_only !== true) {
    throw new Error('personality provenance.safe_summary_only must be true');
  }

  rejectUnsafeMarkers(state);

  return true;
}

function applyPersonalityDelta(previous, delta, options = {}) {
  const prior = normalizePersonalityState(previous || {});
  const incoming = normalizePersonalityState({
    ...prior,
    ...(delta || {}),
    traits: {
      ...prior.traits,
      ...(delta && delta.traits ? delta.traits : {})
    },
    values: mergeStringLists(prior.values, delta && delta.values ? delta.values : [])
  });

  const alpha = clampUnit(options.alpha ?? 0.12, 'personality alpha');
  const traits = {};

  for (const trait of TRAIT_NAMES) {
    traits[trait] = round(prior.traits[trait] + ((incoming.traits[trait] - prior.traits[trait]) * alpha));
  }

  const next = {
    ...prior,
    updated_at: nowIso(),
    traits,
    values: mergeStringLists(prior.values, incoming.values),
    likes: mergeEntryLists(prior.likes, incoming.likes, 'likes'),
    dislikes: mergeEntryLists(prior.dislikes, incoming.dislikes, 'dislikes'),
    fears: mergeEntryLists(prior.fears, incoming.fears, 'fears'),
    hopes: mergeEntryLists(prior.hopes, incoming.hopes, 'hopes'),
    dreams: mergeEntryLists(prior.dreams, incoming.dreams, 'dreams'),
    opinions: mergeEntryLists(prior.opinions, incoming.opinions, 'opinions'),
    provenance: {
      source_memory_ids: mergeStringLists(
        prior.provenance.source_memory_ids,
        incoming.provenance.source_memory_ids
      ),
      source_event_ids: mergeStringLists(
        prior.provenance.source_event_ids,
        incoming.provenance.source_event_ids
      ),
      safe_summary_only: true
    }
  };

  validatePersonalityState(next);
  return next;
}

function mergeStringLists(a, b) {
  const merged = [];

  for (const value of [...(a || []), ...(b || [])]) {
    if (typeof value !== 'string') {
      continue;
    }

    const safe = value.trim().toLowerCase();

    if (safe && !merged.includes(safe)) {
      merged.push(safe);
    }
  }

  return merged.slice(0, 128);
}

function mergeEntryLists(a, b, listName) {
  return normalizeEntryList([...(a || []), ...(b || [])], listName);
}

function summarizePersonality(state) {
  validatePersonalityState(state);

  return {
    updated_at: state.updated_at,
    top_traits: Object.entries(state.traits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value })),
    values: state.values.slice(0, 8),
    likes: state.likes.slice(0, 5).map((entry) => ({ name: entry.name, strength: entry.strength })),
    dislikes: state.dislikes.slice(0, 5).map((entry) => ({ name: entry.name, strength: entry.strength })),
    fears: state.fears.slice(0, 5).map((entry) => ({ name: entry.name, strength: entry.strength })),
    hopes: state.hopes.slice(0, 5).map((entry) => ({ name: entry.name, strength: entry.strength })),
    dreams: state.dreams.slice(0, 5).map((entry) => ({ name: entry.name, strength: entry.strength }))
  };
}

module.exports = {
  PERSONALITY_SCHEMA,
  PERSONALITY_LISTS,
  TRAIT_NAMES,
  DEFAULT_PERSONALITY_STATE,
  cloneDefaultPersonalityState,
  rejectUnsafeMarkers,
  normalizeTerm,
  normalizePersonalityState,
  validatePersonalityState,
  applyPersonalityDelta,
  summarizePersonality
};
