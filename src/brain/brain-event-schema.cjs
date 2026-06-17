'use strict';

/**
 * Floki-v2 brain event schema.
 *
 * Brain events are the only safe input format for brain modules.
 *
 * Design rules:
 * - Every event has provenance.
 * - Every event has an explicit source.
 * - Every event has an explicit modality.
 * - Events may contain user text, system observations, model summaries, or internal signals.
 * - Raw hidden reasoning must never be placed in an event payload.
 */

const { nowIso, assertIsoString } = require('../util/time.cjs');
const { eventId, isSafeId, fingerprint } = require('../util/ids.cjs');

const EVENT_TYPES = Object.freeze([
  'user_text',
  'system_text',
  'internal_signal',
  'memory_recall',
  'memory_consolidation',
  'affect_update',
  'personality_update',
  'goal_update',
  'diagnostic',
  'vision_static_png',
  'model_response_summary',
  'safety_interruption'
]);

const EVENT_MODALITIES = Object.freeze([
  'text',
  'state',
  'memory',
  'affect',
  'vision',
  'diagnostic',
  'control'
]);

const EVENT_SOURCES = Object.freeze([
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

function enumIncludes(values, value) {
  return values.includes(value);
}

function assertPlainObject(value, fieldName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be a plain object`);
  }
}

function sanitizePayload(payload) {
  assertPlainObject(payload, 'payload');

  const serialized = JSON.stringify(payload);
  const bannedMarkers = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  const lower = serialized.toLowerCase();
  for (const marker of bannedMarkers) {
    if (lower.includes(marker)) {
      throw new Error(`payload contains banned reasoning marker: ${marker}`);
    }
  }

  return payload;
}

function createBrainEvent(input) {
  assertPlainObject(input, 'brain event input');

  const createdAt = input.created_at ? String(input.created_at) : nowIso();
  assertIsoString(createdAt, 'created_at');

  const type = input.type;
  const source = input.source;
  const modality = input.modality;

  if (!enumIncludes(EVENT_TYPES, type)) {
    throw new TypeError(`invalid brain event type: ${type}`);
  }

  if (!enumIncludes(EVENT_SOURCES, source)) {
    throw new TypeError(`invalid brain event source: ${source}`);
  }

  if (!enumIncludes(EVENT_MODALITIES, modality)) {
    throw new TypeError(`invalid brain event modality: ${modality}`);
  }

  const payload = sanitizePayload(input.payload || {});

  const provenance = input.provenance || {};
  assertPlainObject(provenance, 'provenance');

  const event = {
    id: input.id || eventId(),
    type,
    source,
    modality,
    created_at: createdAt,
    payload,
    provenance: {
      parent_event_ids: Array.isArray(provenance.parent_event_ids) ? provenance.parent_event_ids.slice() : [],
      trace_id: typeof provenance.trace_id === 'string' ? provenance.trace_id : null,
      observed_by: typeof provenance.observed_by === 'string' ? provenance.observed_by : source,
      confidence: typeof provenance.confidence === 'number' ? provenance.confidence : 1,
      notes: typeof provenance.notes === 'string' ? provenance.notes : ''
    }
  };

  validateBrainEvent(event);

  event.provenance.content_fingerprint = fingerprint({
    type: event.type,
    source: event.source,
    modality: event.modality,
    created_at: event.created_at,
    payload: event.payload,
    parent_event_ids: event.provenance.parent_event_ids
  }, 16);

  return event;
}

function validateBrainEvent(event) {
  assertPlainObject(event, 'brain event');

  if (!isSafeId(event.id)) {
    throw new TypeError('brain event id must be a safe Floki-v2 event ID');
  }

  if (!enumIncludes(EVENT_TYPES, event.type)) {
    throw new TypeError(`invalid brain event type: ${event.type}`);
  }

  if (!enumIncludes(EVENT_SOURCES, event.source)) {
    throw new TypeError(`invalid brain event source: ${event.source}`);
  }

  if (!enumIncludes(EVENT_MODALITIES, event.modality)) {
    throw new TypeError(`invalid brain event modality: ${event.modality}`);
  }

  assertIsoString(event.created_at, 'created_at');
  sanitizePayload(event.payload);

  assertPlainObject(event.provenance, 'provenance');

  if (!Array.isArray(event.provenance.parent_event_ids)) {
    throw new TypeError('provenance.parent_event_ids must be an array');
  }

  for (const parentId of event.provenance.parent_event_ids) {
    if (!isSafeId(parentId)) {
      throw new TypeError(`invalid parent event ID: ${parentId}`);
    }
  }

  if (typeof event.provenance.confidence !== 'number' || event.provenance.confidence < 0 || event.provenance.confidence > 1) {
    throw new TypeError('provenance.confidence must be a number from 0 to 1');
  }

  return true;
}

function makeUserTextEvent(text, options = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('user text event requires non-empty text');
  }

  return createBrainEvent({
    type: 'user_text',
    source: 'user',
    modality: 'text',
    payload: {
      text
    },
    provenance: {
      trace_id: options.trace_id || null,
      observed_by: 'user',
      confidence: 1,
      notes: options.notes || ''
    }
  });
}

function makeDiagnosticEvent(moduleName, diagnostic, options = {}) {
  if (typeof moduleName !== 'string' || moduleName.trim() === '') {
    throw new TypeError('diagnostic event requires moduleName');
  }

  assertPlainObject(diagnostic, 'diagnostic');

  return createBrainEvent({
    type: 'diagnostic',
    source: moduleName,
    modality: 'diagnostic',
    payload: diagnostic,
    provenance: {
      parent_event_ids: options.parent_event_ids || [],
      trace_id: options.trace_id || null,
      observed_by: moduleName,
      confidence: typeof options.confidence === 'number' ? options.confidence : 1,
      notes: options.notes || ''
    }
  });
}

module.exports = {
  EVENT_TYPES,
  EVENT_MODALITIES,
  EVENT_SOURCES,
  createBrainEvent,
  validateBrainEvent,
  makeUserTextEvent,
  makeDiagnosticEvent
};
