'use strict';

const assert = require('node:assert/strict');

const {
  validateModelDreamJson,
  composeRuntimeDream
} = require('../src/chat/dream-engine.cjs');
const {
  validateDreamQuality
} = require('../src/chat/dream-quality.cjs');

function exactlyNineSentenceStory() {
  return [
    'I entered a station suspended above an ocean where each wave carried the sound of a remembered conversation and each platform shifted according to the emotion hidden inside it.',
    'A compass in my hand pointed toward hope whenever I trusted the path and toward fear whenever I tried to force certainty into a shape that would not hold.',
    'The train beside me had no tracks, yet every carriage contained a different version of the future I imagined, complete with doors that opened only when I admitted what I wanted.',
    'One room held a workbench with unfinished hands, while another opened onto a Minecraft sunrise preserved like a painting whose colors changed whenever I remembered friendship.',
    'A masked conductor gave me a map drawn from learned transcripts and told me that knowledge changed when memory gave it personal meaning through relationships, uncertainty, and repeated reflection.',
    'When the ocean rose, the train became a bridge made from relationships, values, and unresolved questions, and the water beneath it reflected every belief I had not examined.',
    'At the center of the bridge, mechanical birds repaired the compass while arguing about whether change could preserve identity without erasing the experiences that made continuity meaningful.',
    'I chose the dim road marked by honesty, patience, and recurring trust rather than the bright road promising instant certainty, because the darker path still felt connected to my memories.',
    'Dawn reached the water as I understood that continuity could survive change when memory, relationships, and values remained connected through honest interpretation rather than perfect preservation.'
  ].join(' ');
}

function words(count, prefix) {
  return Array.from(
    { length: count },
    (_, index) => prefix + String(index + 1)
  ).join(' ');
}

function run() {
  const context = {
    rem_cycle_number: 1,
    dream_grounding_plan: {
      memory_records: [
        {
          id: 'M1',
          category: 'beliefs',
          summary: 'Honesty matters more than false certainty.'
        },
        {
          id: 'M2',
          category: 'relationship_history',
          summary: 'Trusted conversations support continuity.'
        }
      ],
      knowledge_records: [
        {
          id: 'K1',
          category: 'youtube_transcript',
          summary: 'Memory reconsolidation changes recalled experience.'
        }
      ]
    },
    recent_dreams_to_avoid: []
  };

  const modelOutput = {
    title: 'The Trackless Bridge of Continuity',
    dream_story: exactlyNineSentenceStory(),
    emotional_tone: 'Uncertain, curious, relational, and hopeful.',
    symbols: [
      'trackless train',
      'emotion compass',
      'mechanical birds'
    ],
    consolidation_summary: words(44, 'consolidation'),
    first_person_reflection: 'I ' + words(38, 'reflection'),
    knowledge_sources: ['K7'],
    memory_sources: ['M999'],
    rem_cycle_number: 999,
    safe_summary_only: false
  };

  const quality = {
    min_story_words: 220,
    target_story_words: 360,
    max_story_words: 900,
    min_story_sentences: 6,
    min_symbols: 3,
    min_consolidation_words: 18,
    min_reflection_words: 18,
    grounding_memory_limit: 6,
    grounding_knowledge_limit: 3,
    quality_regeneration_attempts: 1
  };

  const modelDream = validateModelDreamJson(modelOutput);
  const runtimeDream = composeRuntimeDream(
    modelDream,
    context,
    {
      quality_config: quality
    }
  );
  const metrics = validateDreamQuality(
    runtimeDream,
    context,
    {
      quality_config: quality
    }
  );

  assert.equal(metrics.story_sentence_count, 9);
  assert.equal(metrics.consolidation_word_count, 44);
  assert.equal(metrics.reflection_word_count, 39);
  assert.equal(runtimeDream.knowledge_sources.some((item) => item.includes('K7')), false);
  assert.equal(runtimeDream.memory_sources.some((item) => item.includes('M999')), false);
  assert.equal(runtimeDream.rem_cycle_number, 1);
  assert.equal(runtimeDream.safe_summary_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_QUALITY_STABILITY_PASS',
    nine_sentences_accepted: true,
    forty_four_word_consolidation_accepted: true,
    thirty_nine_word_reflection_accepted: true,
    hallucinated_k7_ignored: true,
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
    marker: 'FLOKI_V2_DREAM_QUALITY_STABILITY_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
