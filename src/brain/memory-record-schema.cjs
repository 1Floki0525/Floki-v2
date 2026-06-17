'use strict';

/**
 * Floki-v2 memory record schema.
 *
 * Memory records are durable summaries, not raw private reasoning.
 *
 * Design rules:
 * - Every memory has provenance.
 * - Every memory belongs to a stream.
 * - Every memory has safe summarized content.
 * - Every memory can be recalled deterministically before model-based recall exists.
 */

const { nowIso, assertIsoString } = require('../util/time.cjs');
const { memoryId, isSafeId, fingerprint } = require('../util/ids.cjs');

const MEMORY_STREAMS = Object.freeze([
  'short_term',
  'episodic',
  'semantic',
  'autobiographical'
]);

const MEMORY_TYPES = Object.freeze([
  'experience',
  'fact',
  'preference',
  'relationship',
  'identity',
  'goal',
  'emotion',
  'skill',
  'diagnostic_summary'
]);

const MEMORY_SOURCES = Object.freeze([
  'user',
  'system',
  'thalamus',
  'frontal',
  'hippocampus',
  'amygdala',
  'emotions_base',
  'personality',
  'broca',
  'temporal',
  'occipital',
  'cerebellum',
  'pineal',
  'test'
]);

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

function clampNumber(value, fallback, min, max, fieldName) {
  const chosen = typeof value === 'number' ? value : fallback;

  if (!Number.isFinite(chosen)) {
    throw new TypeError(`${fieldName} must be finite`);
  }

  return Math.min(max, Math.max(min, chosen));
}

function normalizeStream(stream) {
  if (stream === 'short-term') {
    return 'short_term';
  }

  if (typeof stream !== 'string') {
    throw new TypeError('memory stream must be a string');
  }

  const normalized = stream.trim().toLowerCase();

  if (!MEMORY_STREAMS.includes(normalized)) {
    throw new Error(`invalid memory stream: ${stream}`);
  }

  return normalized;
}

function normalizeTags(tags) {
  if (typeof tags === 'undefined' || tags === null) {
    return [];
  }

  if (!Array.isArray(tags)) {
    throw new TypeError('memory tags must be an array');
  }

  const normalized = [];

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new TypeError('memory tag must be a string');
    }

    const safeTag = tag
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);

    if (safeTag && !normalized.includes(safeTag)) {
      normalized.push(safeTag);
    }
  }

  return normalized;
}

function sanitizeText(value, fieldName, options = {}) {
  assertNonEmptyString(value, fieldName);

  const trimmed = value.trim();
  const maxLength = options.maxLength || 4000;

  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} is too long; max ${maxLength} characters`);
  }

  rejectUnsafeMarkers(trimmed, fieldName);
  return trimmed;
}

function rejectUnsafeMarkers(value, fieldName = 'value') {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const lower = serialized.toLowerCase();

  const bannedMarkers = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  for (const marker of bannedMarkers) {
    if (lower.includes(marker)) {
      throw new Error(`${fieldName} contains banned private-reasoning marker: ${marker}`);
    }
  }

  return true;
}

function createMemoryRecord(input) {
  assertPlainObject(input, 'memory input');

  const stream = normalizeStream(input.stream || 'short_term');
  const type = input.type || 'experience';

  if (!MEMORY_TYPES.includes(type)) {
    throw new Error(`invalid memory type: ${type}`);
  }

  const source = input.source || 'hippocampus';

  if (!MEMORY_SOURCES.includes(source)) {
    throw new Error(`invalid memory source: ${source}`);
  }

  const content = input.content || {};
  assertPlainObject(content, 'memory content');

  const summary = sanitizeText(content.summary, 'memory content.summary', {
    maxLength: 2000
  });

  const detail = typeof content.detail === 'string' && content.detail.trim()
    ? sanitizeText(content.detail, 'memory content.detail', { maxLength: 6000 })
    : '';

  const createdAt = input.created_at || nowIso();
  assertIsoString(createdAt, 'memory created_at');

  const sourceEventIds = Array.isArray(input.source_event_ids) ? input.source_event_ids.slice() : [];
  const sourceMemoryIds = Array.isArray(input.source_memory_ids) ? input.source_memory_ids.slice() : [];

  for (const eventId of sourceEventIds) {
    if (!isSafeId(eventId)) {
      throw new TypeError(`invalid source event id: ${eventId}`);
    }
  }

  for (const memoryRecordId of sourceMemoryIds) {
    if (!isSafeId(memoryRecordId)) {
      throw new TypeError(`invalid source memory id: ${memoryRecordId}`);
    }
  }

  const record = {
    id: input.id || memoryId(),
    stream,
    type,
    source,
    created_at: createdAt,
    updated_at: createdAt,
    content: {
      summary,
      detail
    },
    tags: normalizeTags(input.tags),
    importance: clampNumber(input.importance, 0.5, 0, 1, 'importance'),
    confidence: clampNumber(input.confidence, 1, 0, 1, 'confidence'),
    affect: {
      valence: clampNumber(input.affect && input.affect.valence, 0, -1, 1, 'affect.valence'),
      arousal: clampNumber(input.affect && input.affect.arousal, 0, 0, 1, 'affect.arousal')
    },
    provenance: {
      source_event_ids: sourceEventIds,
      source_memory_ids: sourceMemoryIds,
      trace_id: typeof input.trace_id === 'string' ? input.trace_id : null,
      observed_by: typeof input.observed_by === 'string' ? input.observed_by : source,
      safe_summary_only: true
    }
  };

  validateMemoryRecord(record);

  record.provenance.content_fingerprint = fingerprint({
    stream: record.stream,
    type: record.type,
    source: record.source,
    created_at: record.created_at,
    content: record.content,
    tags: record.tags,
    source_event_ids: record.provenance.source_event_ids,
    source_memory_ids: record.provenance.source_memory_ids
  }, 16);

  return record;
}

function validateMemoryRecord(record) {
  assertPlainObject(record, 'memory record');

  if (!isSafeId(record.id)) {
    throw new TypeError('memory record id must be a safe Floki-v2 memory ID');
  }

  if (!MEMORY_STREAMS.includes(record.stream)) {
    throw new Error(`invalid memory stream: ${record.stream}`);
  }

  if (!MEMORY_TYPES.includes(record.type)) {
    throw new Error(`invalid memory type: ${record.type}`);
  }

  if (!MEMORY_SOURCES.includes(record.source)) {
    throw new Error(`invalid memory source: ${record.source}`);
  }

  assertIsoString(record.created_at, 'memory created_at');
  assertIsoString(record.updated_at, 'memory updated_at');

  assertPlainObject(record.content, 'memory content');
  sanitizeText(record.content.summary, 'memory content.summary', {
    maxLength: 2000
  });

  if (typeof record.content.detail !== 'string') {
    throw new TypeError('memory content.detail must be a string');
  }

  if (record.content.detail.trim()) {
    sanitizeText(record.content.detail, 'memory content.detail', {
      maxLength: 6000
    });
  }

  if (!Array.isArray(record.tags)) {
    throw new TypeError('memory tags must be an array');
  }

  normalizeTags(record.tags);

  if (typeof record.importance !== 'number' || record.importance < 0 || record.importance > 1) {
    throw new TypeError('memory importance must be a number from 0 to 1');
  }

  if (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1) {
    throw new TypeError('memory confidence must be a number from 0 to 1');
  }

  assertPlainObject(record.affect, 'memory affect');

  if (typeof record.affect.valence !== 'number' || record.affect.valence < -1 || record.affect.valence > 1) {
    throw new TypeError('memory affect.valence must be from -1 to 1');
  }

  if (typeof record.affect.arousal !== 'number' || record.affect.arousal < 0 || record.affect.arousal > 1) {
    throw new TypeError('memory affect.arousal must be from 0 to 1');
  }

  assertPlainObject(record.provenance, 'memory provenance');

  if (record.provenance.safe_summary_only !== true) {
    throw new Error('memory provenance.safe_summary_only must be true');
  }

  rejectUnsafeMarkers(record, 'memory record');

  return true;
}

function memoryText(record) {
  validateMemoryRecord(record);
  return [
    record.content.summary,
    record.content.detail,
    record.tags.join(' '),
    record.type,
    record.stream
  ].join(' ').toLowerCase();
}

function tokenizeQueryText(text) {
  if (typeof text !== 'string') {
    return [];
  }

  return text
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreMemoryRecord(record, query) {
  validateMemoryRecord(record);
  assertPlainObject(query, 'memory recall query');

  const textTerms = tokenizeQueryText(query.text || '');
  const queryTags = normalizeTags(query.tags || []);
  const wantedEventIds = Array.isArray(query.source_event_ids) ? query.source_event_ids : [];

  let score = 0;
  const text = memoryText(record);

  for (const term of textTerms) {
    if (text.includes(term)) {
      score += 1;
    }
  }

  for (const tag of queryTags) {
    if (record.tags.includes(tag)) {
      score += 4;
    }
  }

  for (const eventId of wantedEventIds) {
    if (record.provenance.source_event_ids.includes(eventId)) {
      score += 6;
    }
  }

  if (query.type && record.type === query.type) {
    score += 2;
  }

  if (query.stream && record.stream === normalizeStream(query.stream)) {
    score += 2;
  }

  score += record.importance;

  return Number(score.toFixed(4));
}

module.exports = {
  MEMORY_STREAMS,
  MEMORY_TYPES,
  MEMORY_SOURCES,
  normalizeStream,
  normalizeTags,
  rejectUnsafeMarkers,
  createMemoryRecord,
  validateMemoryRecord,
  memoryText,
  tokenizeQueryText,
  scoreMemoryRecord
};
