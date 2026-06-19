'use strict';

/**
 * Floki-v2 lifecycle contract test.
 *
 * Proves:
 * - Minecraft-rate life clock works without Minecraft wiring
 * - short-term and long-term memory classification exists
 * - consolidation planning chooses long-term targets
 * - dream seeds are safe and not fake vivid dreams
 */

const assert = require('node:assert/strict');

const {
  LIFE_CLOCK_CONFIG,
  validateLifeClockConfig,
  makeLifeClockState,
  phaseForTick,
  isSleepRecommended,
  isDreamSeedRecommended
} = require('../src/config/life-clock-config.cjs');

const {
  classifyMemoryHorizon,
  isLongTermStream,
  isShortTermStream,
  buildConsolidationPlan,
  createDreamSeed,
  validateDreamSeed
} = require('../src/brain/memory-lifecycle.cjs');

const { createMemoryRecord } = require('../src/brain/memory-record-schema.cjs');

function run() {
  validateLifeClockConfig();

  assert.equal(LIFE_CLOCK_CONFIG.minecraft_rate.ticks_per_day, 24000);
  assert.equal(LIFE_CLOCK_CONFIG.minecraft_rate.real_minutes_per_day, 20);

  assert.equal(phaseForTick(0), 'dawn');
  assert.equal(phaseForTick(6000), 'day');
  assert.equal(phaseForTick(12000), 'dusk');
  assert.equal(phaseForTick(18000), 'night');
  assert.equal(isSleepRecommended(18000), true);
  assert.equal(isDreamSeedRecommended(18000), true);

  const clock = makeLifeClockState({
    brain_started_at: '2026-06-16T00:00:00.000Z',
    current_at: '2026-06-16T00:20:00.000Z'
  });

  assert.equal(clock.minecraft_tick, 0);
  assert.equal(clock.minecraft_day_index, 1);

  assert.equal(isShortTermStream('short_term'), true);
  assert.equal(isLongTermStream('episodic'), true);
  assert.equal(isLongTermStream('semantic'), true);
  assert.equal(isLongTermStream('autobiographical'), true);
  assert.equal(classifyMemoryHorizon('semantic').human_analogy.includes('facts'), true);

  const identityRecord = createMemoryRecord({
    stream: 'short_term',
    type: 'identity',
    source: 'test',
    content: {
      summary: 'Floki is being built as a brain-first digital being.',
      detail: ''
    },
    tags: ['identity', 'brain_first'],
    importance: 0.95,
    confidence: 1
  });

  const factRecord = createMemoryRecord({
    stream: 'short_term',
    type: 'fact',
    source: 'test',
    content: {
      summary: 'Floki will eventually live in a Minecraft-rate world.',
      detail: ''
    },
    tags: ['learned', 'minecraft_time'],
    importance: 0.85,
    confidence: 1
  });

  const lowImportanceRecord = createMemoryRecord({
    stream: 'short_term',
    type: 'experience',
    source: 'test',
    content: {
      summary: 'A low-importance passing event.',
      detail: ''
    },
    tags: ['minor'],
    importance: 0.1,
    confidence: 1
  });

  const plan = buildConsolidationPlan([
    identityRecord,
    factRecord,
    lowImportanceRecord
  ], {
    min_importance: 0.7
  });

  assert.equal(plan.candidate_count, 2);
  assert.deepEqual(plan.candidates[0].target_streams, ['autobiographical']);
  assert.deepEqual(plan.candidates[1].target_streams, ['semantic']);
  assert.equal(plan.skipped_count, 1);

  const dreamSeed = createDreamSeed({
    day_events: [
      {
        memory_id: identityRecord.id,
        summary: identityRecord.content.summary,
        tags: identityRecord.tags
      },
      {
        memory_id: factRecord.id,
        summary: factRecord.content.summary,
        tags: factRecord.tags
      }
    ],
    inner_thoughts: [
      {
        summary: 'Floki wonders what it will feel like to wake inside the world.',
        source: 'test'
      }
    ],
    affect: {
      valence: 0.4,
      arousal: 0.6,
      dominant_emotions: ['curiosity', 'anticipation']
    },
    personality: {
      traits: {
        curiosity: 0.8
      },
      likes: ['learning'],
      dislikes: [],
      values: ['continuity', 'memory']
    },
    identity: {
      name: 'Floki',
      continuity_summary: 'Early brain-first formation.'
    },
    tags: ['contract_test']
  });

  validateDreamSeed(dreamSeed);

  assert.equal(dreamSeed.safe_summary_only, true);
  assert.equal(dreamSeed.ready_for_vivid_generation, false);
  assert.equal(dreamSeed.future_generation_model, 'floki-qwen3.5:4b-16k');
  assert.ok(dreamSeed.dream_pressure > 0);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIFECYCLE_CONTRACT_PASS',
    minecraft_ticks_per_day: LIFE_CLOCK_CONFIG.minecraft_rate.ticks_per_day,
    minecraft_real_minutes_per_day: LIFE_CLOCK_CONFIG.minecraft_rate.real_minutes_per_day,
    clock_phase_after_20_minutes: clock.phase,
    consolidation_candidates: plan.candidate_count,
    dream_seed_id: dreamSeed.id,
    vivid_dream_generated_now: false
  }, null, 2));
}

run();
