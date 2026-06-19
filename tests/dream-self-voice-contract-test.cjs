'use strict';

const assert = require('node:assert/strict');

const {
  RUNTIME_OWNED_DREAM_FIELDS,
  DREAM_ENGINE_SCHEMA,
  validateModelDreamJson,
  composeRuntimeDream,
  containsExplicitThirdPersonSelfNarration,
  hasFirstPersonVoice,
  assertDreamSelfVoice,
  runtimeRememberedAs,
  runtimeFirstPersonReflection
} = require('../src/chat/dream-engine.cjs');

function baseModelDream(overrides = {}) {
  return {
    title: 'The City Beneath the Turning Sky',
    dream_story: [
      'I crossed a city beneath a turning sky while another traveler walked beside me.',
      'He carried his own map, and I understood that ordinary third-person references to other dream figures must remain valid.',
      'I reached an archive where my memories became lights and the streets rearranged around the values I chose to carry.',
      'I woke with a clearer sense that continuity could survive change through honesty, relationships, and patient learning.'
    ].join(' '),
    emotional_tone: 'Curious, unsettled, relational, and hopeful.',
    symbols: [
      'turning sky',
      'archive doors',
      'memory lights'
    ],
    consolidation_summary: 'The dream joins memory continuity, relationships, uncertainty, and learning into one symbolic transition.',
    first_person_reflection: 'The journey changed the meaning of uncertainty and made patience feel more important.',
    ...overrides
  };
}

function context() {
  return {
    rem_cycle_number: 1,
    dream_grounding_plan: {
      memory_records: [{
        id: 'M1',
        category: 'beliefs',
        summary: 'Honesty matters more than false certainty.'
      }],
      knowledge_records: []
    },
    recent_dreams_to_avoid: []
  };
}

function run() {
  assert.equal(RUNTIME_OWNED_DREAM_FIELDS.includes('remembered_as'), true);
  assert.equal(DREAM_ENGINE_SCHEMA.required.includes('remembered_as'), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      DREAM_ENGINE_SCHEMA.properties,
      'remembered_as'
    ),
    false
  );

  assert.equal(hasFirstPersonVoice('I may remember a bridge.'), true);
  assert.equal(hasFirstPersonVoice('What remained with me was a bridge.'), true);
  assert.equal(hasFirstPersonVoice('The journey changed my understanding.'), true);
  assert.equal(hasFirstPersonVoice('The dream left him hopeful.'), false);

  assert.equal(
    containsExplicitThirdPersonSelfNarration(
      'I followed a conductor because he knew the path.'
    ),
    false
  );
  assert.equal(
    containsExplicitThirdPersonSelfNarration(
      'I watched another traveler carry his own map.'
    ),
    false
  );
  assert.equal(
    containsExplicitThirdPersonSelfNarration(
      'Floki remembers a bridge.'
    ),
    true
  );

  assert.equal(
    assertDreamSelfVoice(
      'I walked through a city while another traveler carried his map.',
      'dream_story'
    ),
    true
  );

  assert.throws(
    () => assertDreamSelfVoice(
      'Floki walked through a city.',
      'dream_story'
    ),
    /third-person/
  );

  const modelDream = validateModelDreamJson(baseModelDream());
  assert.equal(
    Object.prototype.hasOwnProperty.call(modelDream, 'remembered_as'),
    false
  );

  const rememberedAs = runtimeRememberedAs(modelDream);
  assert.equal(hasFirstPersonVoice(rememberedAs), true);
  assert.equal(
    containsExplicitThirdPersonSelfNarration(rememberedAs),
    false
  );

  const normalizedReflection = runtimeFirstPersonReflection(
    modelDream.first_person_reflection
  );
  assert.equal(hasFirstPersonVoice(normalizedReflection), true);
  assert.equal(
    normalizedReflection.startsWith(
      'I reflect on this dream through this thought:'
    ),
    true
  );

  assert.throws(
    () => runtimeFirstPersonReflection(
      'Floki felt that the bridge represented continuity.'
    ),
    /third-person/
  );

  const runtimeDream = composeRuntimeDream(modelDream, context());
  assert.equal(hasFirstPersonVoice(runtimeDream.dream_story), true);
  assert.equal(hasFirstPersonVoice(runtimeDream.remembered_as), true);
  assert.equal(
    hasFirstPersonVoice(runtimeDream.first_person_reflection),
    true
  );
  assert.equal(
    containsExplicitThirdPersonSelfNarration(
      runtimeDream.first_person_reflection
    ),
    false
  );

  assert.throws(
    () => validateModelDreamJson(baseModelDream({
      dream_story: 'Floki crossed a city and remembered his past.'
    })),
    /third-person/
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_SELF_VOICE_CONTRACT_PASS',
    dream_story_hard_first_person: true,
    remembered_as_runtime_first_person: true,
    reflection_runtime_first_person_guarantee: true,
    ordinary_other_person_references_allowed: true,
    explicit_floki_third_person_blocked: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_SELF_VOICE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
