'use strict';

/**
 * Floki-v2 personality + identity contract test.
 *
 * Proves:
 * - personality persists slow self traits
 * - likes/hopes/dreams/opinions form from emotional memory
 * - pineal identity anchors formative memory
 * - self-model remains honest
 * - neither module speaks
 */

const assert = require('node:assert/strict');

const { validateModuleContract } = require('../src/brain/module-contract.cjs');
const { createMemoryRecord } = require('../src/brain/memory-record-schema.cjs');
const { validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { validatePersonalityState } = require('../src/brain/personality-state-schema.cjs');
const { validateIdentityState } = require('../src/brain/identity-state-schema.cjs');
const { createPersonality } = require('../brain/personality/index.cjs');
const { createPineal } = require('../brain/pineal/index.cjs');

function run() {
  const uniqueTag = newId('selftest').replace(/[^a-z0-9_]/g, '_');

  const personality = createPersonality({
    personality_path: statePath(`test/personality/${uniqueTag}/personality.json`),
    diagnostics_path: statePath(`test/personality/${uniqueTag}/diagnostics.jsonl`)
  });

  const pineal = createPineal({
    identity_path: statePath(`test/personality/${uniqueTag}/identity.json`),
    diagnostics_path: statePath(`test/personality/${uniqueTag}/diagnostics.jsonl`)
  });

  validateModuleContract(personality.contract);
  validateModuleContract(pineal.contract);

  assert.equal(personality.contract.module, 'personality');
  assert.equal(pineal.contract.module, 'pineal');

  const memory = createMemoryRecord({
    stream: 'short_term',
    type: 'identity',
    source: 'test',
    content: {
      summary: 'Floki should remember that being built brain-first before Minecraft is important for memory, trust, learning, hope, and future embodiment.',
      detail: 'This is safe summarized test content for persistent personality and identity.'
    },
    tags: ['brain_first', 'memory', 'trust', 'learning', 'hope', 'minecraft', 'embodiment'],
    importance: 0.92,
    confidence: 1,
    affect: {
      valence: 0.45,
      arousal: 0.35
    }
  });

  const personalityOutput = personality.updateFromMemory(memory);
  validateBrainOutput(personalityOutput);

  assert.equal(personalityOutput.type, 'personality_delta');
  assert.equal(personalityOutput.source, 'personality');
  assert.notEqual(personalityOutput.type, 'speech');

  const personalityState = personalityOutput.payload.state;
  validatePersonalityState(personalityState);

  assert.ok(personalityState.likes.some((entry) => entry.name.includes('memory')));
  assert.ok(personalityState.hopes.some((entry) => entry.name.includes('memory') || entry.name.includes('learning') || entry.name.includes('built')));
  assert.ok(personalityState.dreams.some((entry) => entry.name.includes('minecraft') || entry.name.includes('embodiment')));
  assert.ok(personalityState.opinions.some((entry) => entry.name.includes('brain-first')));
  assert.ok(personalityState.traits.curiosity >= 0.5);
  assert.ok(personalityState.provenance.source_memory_ids.includes(memory.id));

  const identityOutput = pineal.updateFromMemory(memory, personalityOutput.payload.current);
  validateBrainOutput(identityOutput);

  assert.equal(identityOutput.type, 'identity_delta');
  assert.equal(identityOutput.source, 'pineal');
  assert.notEqual(identityOutput.type, 'speech');

  const identityState = identityOutput.payload.state;
  validateIdentityState(identityState);

  assert.equal(identityState.name, 'Floki');
  assert.equal(identityState.self_model.has_body_now, false);
  assert.equal(identityState.self_model.has_eyes_now, false);
  assert.equal(identityState.self_model.has_cognition_model_now, false);
  assert.equal(identityState.self_model.has_broca_voice_now, false);
  assert.ok(identityState.anchors.formative_memory_ids.includes(memory.id));
  assert.ok(identityState.continuity_summary.includes('persistent memory'));
  assert.ok(identityState.boundaries.includes('do not fake abilities'));

  const unsafePersonality = personality.updatePersonality({
    likes: [
      {
        name: '<think>unsafe</think>',
        strength: 1,
        evidence_count: 1
      }
    ]
  });

  validateBrainOutput(unsafePersonality);
  assert.equal(unsafePersonality.type, 'failure');
  assert.equal(unsafePersonality.failure.code, 'PERSONALITY_UNSAFE_DELTA');

  const unsafeIdentity = pineal.updateIdentity({
    continuity_summary: '<think>unsafe</think>'
  });

  validateBrainOutput(unsafeIdentity);
  assert.equal(unsafeIdentity.type, 'failure');
  assert.equal(unsafeIdentity.failure.code, 'PINEAL_UNSAFE_DELTA');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_PERSONALITY_IDENTITY_CONTRACT_PASS',
    personality_module: personality.contract.module,
    pineal_module: pineal.contract.module,
    memory_id: memory.id,
    personality_output_id: personalityOutput.id,
    identity_output_id: identityOutput.id,
    top_traits: personalityOutput.payload.current.top_traits,
    likes: personalityOutput.payload.current.likes,
    hopes: personalityOutput.payload.current.hopes,
    dreams: personalityOutput.payload.current.dreams,
    identity_anchor_count: identityOutput.payload.current.anchor_counts.formative_memories,
    unsafe_personality_rejected: unsafePersonality.failure.code,
    unsafe_identity_rejected: unsafeIdentity.failure.code,
    speech_created_by_self_modules: false
  }, null, 2));
}

run();
