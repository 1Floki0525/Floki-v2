'use strict';

/**
 * Floki-v2 memory lifecycle.
 *
 * Purpose:
 * - Make short-term and long-term memory explicit.
 * - Decide which memories are eligible for long-term consolidation.
 * - Create safe dream seeds without generating fake dream stories.
 *
 * Dream story generation comes later after:
 * - emotions_base
 * - amygdala
 * - personality
 * - pineal
 * - frontal
 * - qwen3.5 cognition
 */

const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');
const {
  validateMemoryRecord,
  normalizeTags,
  rejectUnsafeMarkers
} = require('./memory-record-schema.cjs');

const MEMORY_LIFECYCLE_CONFIG = Object.freeze({
  stage: 'stage_05_memory_lifecycle',

  horizons: Object.freeze({
    short_term: Object.freeze({
      stream: 'short_term',
      horizon: 'short_term',
      human_analogy: 'working memory and recent experience buffer',
      consolidation_required: true,
      default_importance_floor_for_consolidation: 0.7
    }),

    episodic: Object.freeze({
      stream: 'episodic',
      horizon: 'long_term',
      human_analogy: 'remembered events and experiences',
      consolidation_required: false
    }),

    semantic: Object.freeze({
      stream: 'semantic',
      horizon: 'long_term',
      human_analogy: 'facts, meanings, stable knowledge, learned preferences',
      consolidation_required: false
    }),

    autobiographical: Object.freeze({
      stream: 'autobiographical',
      horizon: 'long_term',
      human_analogy: 'self-story, identity continuity, formative memories',
      consolidation_required: false
    })
  }),

  dream_seed: Object.freeze({
    enabled_now: true,
    generate_vivid_story_now: false,
    requires_cognition_for_story: true,
    requires_emotion_state: true,
    requires_personality_state: true,
    requires_identity_state: true
  })
});

function classifyMemoryHorizon(stream) {
  const config = MEMORY_LIFECYCLE_CONFIG.horizons[stream];

  if (!config) {
    throw new Error(`unknown memory stream for lifecycle: ${stream}`);
  }

  return config;
}

function isLongTermStream(stream) {
  return classifyMemoryHorizon(stream).horizon === 'long_term';
}

function isShortTermStream(stream) {
  return classifyMemoryHorizon(stream).horizon === 'short_term';
}

function chooseConsolidationTargets(record, options = {}) {
  validateMemoryRecord(record);

  const minImportance = typeof options.min_importance === 'number'
    ? options.min_importance
    : MEMORY_LIFECYCLE_CONFIG.horizons.short_term.default_importance_floor_for_consolidation;

  if (record.stream !== 'short_term') {
    return [];
  }

  if (record.importance < minImportance) {
    return [];
  }

  if (record.type === 'identity' || record.tags.includes('identity')) {
    return ['autobiographical'];
  }

  if (
    record.type === 'fact' ||
    record.type === 'preference' ||
    record.type === 'skill' ||
    record.tags.includes('learned') ||
    record.tags.includes('preference')
  ) {
    return ['semantic'];
  }

  return ['episodic'];
}

function buildConsolidationPlan(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('buildConsolidationPlan requires an array of memory records');
  }

  const candidates = [];
  const skipped = [];

  for (const record of records) {
    validateMemoryRecord(record);

    const targets = chooseConsolidationTargets(record, options);

    if (targets.length === 0) {
      skipped.push({
        memory_id: record.id,
        reason: record.stream === 'short_term' ? 'below_importance_floor' : 'already_long_term'
      });
      continue;
    }

    candidates.push({
      memory_id: record.id,
      source_stream: record.stream,
      target_streams: targets,
      importance: record.importance,
      type: record.type,
      tags: record.tags.slice()
    });
  }

  return {
    created_at: nowIso(),
    min_importance: typeof options.min_importance === 'number' ? options.min_importance : 0.7,
    candidates,
    skipped,
    candidate_count: candidates.length,
    skipped_count: skipped.length
  };
}

function createDreamSeed(input = {}) {
  const dayEvents = Array.isArray(input.day_events) ? input.day_events : [];
  const innerThoughts = Array.isArray(input.inner_thoughts) ? input.inner_thoughts : [];

  for (const event of dayEvents) {
    rejectUnsafeMarkers(event, 'dream seed day event');
  }

  for (const thought of innerThoughts) {
    rejectUnsafeMarkers(thought, 'dream seed inner thought');
  }

  const affect = input.affect && typeof input.affect === 'object'
    ? input.affect
    : { valence: 0, arousal: 0, dominant_emotions: [] };

  const personality = input.personality && typeof input.personality === 'object'
    ? input.personality
    : { traits: {}, likes: [], dislikes: [], values: [] };

  const identity = input.identity && typeof input.identity === 'object'
    ? input.identity
    : { name: 'Floki', continuity_summary: 'Floki is in early brain-first formation.' };

  rejectUnsafeMarkers(affect, 'dream seed affect');
  rejectUnsafeMarkers(personality, 'dream seed personality');
  rejectUnsafeMarkers(identity, 'dream seed identity');

  const tags = normalizeTags([
    'dream_seed',
    ...(input.tags || []),
    ...(affect.dominant_emotions || [])
  ]);

  return {
    id: newId('dreamseed'),
    created_at: nowIso(),
    stage: MEMORY_LIFECYCLE_CONFIG.stage,
    ready_for_vivid_generation: false,
    reason_not_vivid_yet: 'Cognition, emotions_base, amygdala, personality, pineal, and frontal dream synthesis are not fully wired yet.',
    future_generation_model: 'qwen3.5:4b',
    safe_summary_only: true,
    ingredients: {
      day_event_count: dayEvents.length,
      inner_thought_count: innerThoughts.length,
      affect,
      personality,
      identity,
      day_events: dayEvents,
      inner_thoughts: innerThoughts
    },
    tags,
    dream_pressure: estimateDreamPressure({
      dayEvents,
      innerThoughts,
      affect
    })
  };
}

function estimateDreamPressure(input) {
  const dayEvents = input.dayEvents || [];
  const innerThoughts = input.innerThoughts || [];
  const affect = input.affect || {};

  const arousal = typeof affect.arousal === 'number' ? affect.arousal : 0;
  const eventPressure = Math.min(1, dayEvents.length / 12);
  const thoughtPressure = Math.min(1, innerThoughts.length / 8);
  const affectPressure = Math.min(1, Math.max(0, arousal));

  return Number(((eventPressure * 0.35) + (thoughtPressure * 0.25) + (affectPressure * 0.4)).toFixed(4));
}

function validateDreamSeed(seed) {
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new TypeError('dream seed must be a plain object');
  }

  if (typeof seed.id !== 'string' || !seed.id.startsWith('dreamseed_')) {
    throw new TypeError('dream seed id must start with dreamseed_');
  }

  if (seed.safe_summary_only !== true) {
    throw new Error('dream seed must be safe_summary_only');
  }

  if (seed.ready_for_vivid_generation !== false) {
    throw new Error('vivid dream generation must remain false until cognition is wired');
  }

  rejectUnsafeMarkers(seed, 'dream seed');

  return true;
}

module.exports = {
  MEMORY_LIFECYCLE_CONFIG,
  classifyMemoryHorizon,
  isLongTermStream,
  isShortTermStream,
  chooseConsolidationTargets,
  buildConsolidationPlan,
  createDreamSeed,
  estimateDreamPressure,
  validateDreamSeed
};
