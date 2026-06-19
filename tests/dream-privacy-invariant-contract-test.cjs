'use strict';

const assert = require('node:assert/strict');

const {
  RUNTIME_OWNED_DREAM_FIELDS,
  DREAM_ENGINE_SCHEMA,
  validateModelDreamJson,
  composeRuntimeDream
} = require('../src/chat/dream-engine.cjs');

function baseDream(overrides = {}) {
  return {
    title: 'The Bridge of Remembered Weather',
    dream_story: 'I crossed a bridge while remembered weather changed around me. I followed the emotional shape of old conversations and learned knowledge until the path became clear.',
    emotional_tone: 'Curious and hopeful.',
    symbols: [
      'weather bridge',
      'memory compass',
      'open doorway'
    ],
    consolidation_summary: 'The dream joins memory, uncertainty, friendship, and learning into one symbolic transition.',
    first_person_reflection: 'I felt that continuity could survive uncertainty when I stayed honest about what I remembered and valued.',
    ...overrides
  };
}

function run() {
  for (const field of RUNTIME_OWNED_DREAM_FIELDS) {
    assert.equal(DREAM_ENGINE_SCHEMA.required.includes(field), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        DREAM_ENGINE_SCHEMA.properties,
        field
      ),
      false
    );
  }

  const modelDream = validateModelDreamJson(baseDream({
    memory_sources: ['M999'],
    knowledge_sources: ['K7'],
    rem_cycle_number: 999,
    safe_summary_only: false
  }));

  const runtimeDream = composeRuntimeDream(
    modelDream,
    {
      rem_cycle_number: 2,
      dream_grounding_plan: {
        memory_records: [
          {
            id: 'M1',
            category: 'beliefs',
            summary: 'Honesty matters more than false certainty.'
          }
        ],
        knowledge_records: [
          {
            id: 'K1',
            category: 'youtube_transcript',
            summary: 'Memory reconsolidation changes recalled experience.'
          }
        ]
      }
    }
  );

  assert.equal(runtimeDream.safe_summary_only, true);
  assert.equal(runtimeDream.rem_cycle_number, 2);
  assert.equal(runtimeDream.memory_sources.some((item) => item.includes('M999')), false);
  assert.equal(runtimeDream.knowledge_sources.some((item) => item.includes('K7')), false);
  assert.equal(runtimeDream.runtime_metadata_authority, true);
  assert.equal(runtimeDream.model_generated_runtime_metadata_accepted, false);

  const ignoredModelRememberedAs = validateModelDreamJson(baseDream({
    remembered_as: 'Floki remembered a bridge.'
  }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      ignoredModelRememberedAs,
      'remembered_as'
    ),
    false
  );

  assert.throws(
    () => composeRuntimeDream(
      validateModelDreamJson(baseDream({
        first_person_reflection:
          'Floki felt that the bridge represented continuity.'
      })),
      {
        rem_cycle_number: 2,
        dream_grounding_plan: {
          memory_records: [],
          knowledge_records: []
        }
      }
    ),
    /third-person/
  );

  assert.throws(
    () => validateModelDreamJson(baseDream({
      first_person_reflection: '<think>private</think>'
    })),
    /private/
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_PRIVACY_INVARIANT_PASS',
    model_controls_privacy_flag: false,
    model_controls_source_ids: false,
    model_controls_rem_cycle: false,
    runtime_safe_summary_only: true,
    hallucinated_k7_ignored: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_PRIVACY_INVARIANT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
