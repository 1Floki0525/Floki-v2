'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createChatMemorySubstrate } = require('../src/chat/chat-memory-substrate.cjs');
const {
  buildRichDreamContext
} = require('../src/chat/rich-dream-context.cjs');

function run() {
  const unique = newId('rich_dream_context').replace(/[^a-z0-9_]/g, '_');
  const base = statePath('test/rich-dream-context/' + unique);
  const memoryBase = path.join(base, 'memory');
  ensureDirSync(base);

  const substrate = createChatMemorySubstrate({
    base_dir: memoryBase
  });
  substrate.ensureReady();

  substrate.rememberShortTerm({
    text: 'Binary-God and I discussed how memory, friendship, and embodiment should remain continuous.',
    summary: 'A recent conversation connected memory, friendship, and future embodiment.',
    category: 'relationship_history',
    tags: ['chat', 'conversation', 'relationship', 'hope'],
    importance: 0.95,
    emotion: {
      trust: 0.8,
      hope: 0.7,
      attachment: 0.6
    }
  });

  substrate.rememberLongTerm({
    text: 'I believe honesty matters more than pretending certainty.',
    summary: 'Honesty matters more than pretending certainty.',
    category: 'beliefs',
    tags: ['belief', 'honesty'],
    importance: 0.9,
    emotion: {
      trust: 0.5,
      confidence: 0.4
    }
  });

  substrate.rememberLongTerm({
    text: 'I may be biased toward familiar explanations when uncertainty feels uncomfortable.',
    summary: 'A bias toward familiar explanations can appear when uncertainty feels uncomfortable.',
    category: 'biases',
    tags: ['bias', 'uncertainty'],
    importance: 0.82,
    emotion: {
      uncertainty: 0.7,
      fear: 0.3
    }
  });

  substrate.rememberLongTerm({
    text: 'I hope to develop a continuous embodied life while preserving memory and friendship.',
    summary: 'A hope for continuous embodied life grounded in memory and friendship.',
    category: 'hopes',
    tags: ['hope', 'embodiment', 'friendship'],
    importance: 0.94,
    emotion: {
      hope: 0.9,
      attachment: 0.6
    }
  });

  const context = buildRichDreamContext({
    now: '2026-06-19T05:00:00.000Z',
    memory_substrate: substrate,
    rem_cycle_number: 1,
    dream_root: path.join(base, 'dreams'),
    personality_state: {
      traits: {
        curiosity: 0.9,
        creativity: 0.8,
        trust: 0.7
      },
      values: ['memory', 'honesty', 'friendship', 'growth'],
      likes: [
        {
          name: 'learning through conversation',
          strength: 0.8
        }
      ],
      dislikes: [
        {
          name: 'false certainty',
          strength: 0.9
        }
      ],
      fears: [
        {
          name: 'losing continuity',
          strength: 0.7
        }
      ],
      hopes: [
        {
          name: 'growing through trusted relationships',
          strength: 0.9
        }
      ],
      dreams: [
        {
          name: 'embodied life with persistent memory',
          strength: 0.85
        }
      ],
      opinions: [
        {
          name: 'identity grows through continuity',
          strength: 0.8
        }
      ]
    },
    knowledge_chunks: [
      {
        chunk_id: 'yt-1',
        source_type: 'youtube_transcript',
        title: 'Memory Reconsolidation and Identity',
        channel_folder: 'Cognitive Science',
        video_id: 'video-1',
        text: 'Memory reconsolidation changes remembered experience when it is recalled, allowing identity to remain continuous while interpretations evolve.'
      }
    ]
  });

  const categories = context.dream_grounding_plan.memory_records
    .map((record) => record.category);

  assert.equal(context.day_memories.length >= 1, true);
  assert.equal(context.long_term_memories.length >= 3, true);
  assert.equal(context.beliefs_biases.length >= 2, true);
  assert.equal(context.unresolved_concerns_hopes.length >= 2, true);
  assert.equal(context.personality.values.includes('memory'), true);
  assert.equal(context.dream_grounding_plan.runtime_owned, true);
  assert.equal(context.dream_grounding_plan.model_must_not_emit_source_ids, true);
  assert.equal(context.dream_grounding_plan.memory_records.length >= 3, true);
  assert.equal(context.dream_grounding_plan.knowledge_records.length, 1);
  assert.equal(categories.some((category) => category === 'beliefs' || category === 'belief_or_bias'), true);
  assert.equal(categories.some((category) => category === 'biases' || category === 'belief_or_bias'), true);
  assert.equal(context.persistent_memory_used, true);
  assert.equal(context.personality_used, true);
  assert.equal(context.beliefs_biases_used, true);
  assert.equal(context.knowledge_context_used, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RICH_DREAM_CONTEXT_GROUNDING_PASS',
    recent_memories: context.grounding_counts.recent_memories,
    long_term_memories: context.grounding_counts.long_term_memories,
    beliefs_biases: context.grounding_counts.beliefs_biases,
    runtime_memory_sources: context.dream_grounding_plan.memory_records.length,
    runtime_knowledge_sources: context.dream_grounding_plan.knowledge_records.length,
    personality_used: context.personality_used,
    runtime_metadata_authority: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_RICH_DREAM_CONTEXT_GROUNDING_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
