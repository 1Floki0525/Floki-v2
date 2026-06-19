'use strict';

/**
 * Floki-v2 Pineal
 *
 * Responsibility:
 * - Maintain persistent identity continuity.
 * - Anchor formative memories into Floki's self-story.
 * - Keep the self-model honest about current abilities.
 *
 * It does not speak, call models, move a body, or pretend embodiment exists.
 */

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { validateMemoryRecord } = require('../../src/brain/memory-record-schema.cjs');
const { statePath, readJsonFileSync, writeJsonFileAtomicSync } = require('../../src/util/fs-safe.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');
const {
  cloneDefaultIdentityState,
  normalizeIdentityState,
  validateIdentityState,
  applyIdentityDelta,
  summarizeIdentity
} = require('../../src/brain/identity-state-schema.cjs');
const { buildChatRuntimeCapabilities } = require('../../src/vision/chat-webcam-vision-context.cjs');

const MODULE_NAME = 'pineal';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Maintains persistent identity continuity, self-model honesty, formative memory anchors, and core value continuity.',
  inputs: [
    {
      name: 'memory_record',
      schema: 'src/brain/memory-record-schema.cjs',
      required: false,
      description: 'A safe memory record that may anchor identity.'
    },
    {
      name: 'identity_delta',
      schema: 'src/brain/identity-state-schema.cjs compatible object',
      required: false,
      description: 'Optional direct identity update.'
    },
    {
      name: 'personality_summary',
      schema: 'plain object',
      required: false,
      description: 'Summary of slow personality state used to update continuity.'
    }
  ],
  outputs: [
    {
      type: 'identity_delta',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A persisted identity update with previous/current identity summaries.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Structured failure output when identity update fails.'
    }
  ],
  state_reads: [
    {
      path: 'state/floki/identity.json',
      description: 'Persistent identity state.'
    }
  ],
  state_writes: [
    {
      path: 'state/floki/identity.json',
      description: 'Atomic write of latest identity state.'
    },
    {
      path: 'state/floki/diagnostics.jsonl',
      description: 'Append-only identity diagnostics.'
    }
  ],
  diagnostics: [
    {
      name: 'identity_loaded',
      description: 'Identity state was loaded or initialized.'
    },
    {
      name: 'identity_updated',
      description: 'Identity state changed and was persisted.'
    },
    {
      name: 'identity_failed',
      description: 'Identity operation failed safely.'
    }
  ],
  failure_modes: [
    {
      code: 'PINEAL_LOAD_FAILED',
      description: 'Identity state could not be loaded.'
    },
    {
      code: 'PINEAL_UPDATE_FAILED',
      description: 'Identity state could not be updated or persisted.'
    },
    {
      code: 'PINEAL_UNSAFE_DELTA',
      description: 'Identity update contained unsafe private-reasoning markers.'
    }
  ],
  forbidden: [
    'speech_generation',
    'model_calls',
    'minecraft_calls',
    'body_movement',
    'embodiment_claims_before_body_exists',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Pineal owns identity continuity and honest self-model boundaries.'
});

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function identityPath(options = {}) {
  return options.identity_path || statePath('identity.json');
}

function diagnosticsPath(options = {}) {
  return options.diagnostics_path || statePath('diagnostics.jsonl');
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return {
      ok: true,
      skipped: true
    };
  }

  appendJsonlSync(diagnosticsPath(options), {
    id: diagnosticId(),
    created_at: nowIso(),
    module: MODULE_NAME,
    ...record
  });

  return {
    ok: true,
    skipped: false
  };
}

function loadIdentityState(options = {}) {
  try {
    const raw = readJsonFileSync(identityPath(options), null);

    if (raw === null) {
      const initial = normalizeIdentityState({
        ...cloneDefaultIdentityState(),
        updated_at: nowIso()
      });

      writeJsonFileAtomicSync(identityPath(options), initial);

      persistDiagnostic({
        status: 'identity_loaded',
        initialized: true
      }, options);

      return initial;
    }

    const state = normalizeIdentityState(raw);

    persistDiagnostic({
      status: 'identity_loaded',
      initialized: false
    }, options);

    return state;
  } catch (error) {
    throw new Error(`PINEAL_LOAD_FAILED: ${error.message}`);
  }
}

function saveIdentityState(state, options = {}) {
  validateIdentityState(state);
  writeJsonFileAtomicSync(identityPath(options), state);
  return state;
}

function updateIdentity(delta, options = {}) {
  try {
    const previous = loadIdentityState(options);
    const next = applyIdentityDelta(previous, delta || {});

    saveIdentityState(next, options);

    const output = createBrainOutput({
      type: 'identity_delta',
      source: MODULE_NAME,
      parent_event_ids: next.provenance.source_event_ids,
      payload: {
        previous: summarizeIdentity(previous),
        current: summarizeIdentity(next),
        state: next
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'identity_updated'
      }
    });

    persistDiagnostic({
      status: 'identity_updated',
      output_id: output.id,
      formation_stage: next.formation_stage,
      formative_memory_count: next.anchors.formative_memory_ids.length
    }, options);

    return output;
  } catch (error) {
    return makeFailureOutput(
      MODULE_NAME,
      classifyError(error),
      error.message,
      {
        payload: {
          attempted_delta_keys: delta && typeof delta === 'object' ? Object.keys(delta) : []
        }
      }
    );
  }
}

function identityDeltaFromMemory(record, personalitySummary = {}, runtimeCapabilities = {}) {
  validateMemoryRecord(record);

  const text = `${record.content.summary} ${record.content.detail} ${record.tags.join(' ')}`.toLowerCase();
  const isFormative = record.importance >= 0.7 ||
    record.type === 'identity' ||
    text.includes('brain-first') ||
    text.includes('brain first') ||
    text.includes('before minecraft') ||
    text.includes('memory') ||
    text.includes('identity');

  const formativeMemoryIds = isFormative ? [record.id] : [];
  const identityEventIds = record.provenance.source_event_ids || [];

  const topTraits = Array.isArray(personalitySummary.top_traits)
    ? personalitySummary.top_traits.map((trait) => trait.name).slice(0, 4)
    : [];

  const values = Array.isArray(personalitySummary.values)
    ? personalitySummary.values
    : [];

  const capabilities = Object.freeze({
    ...buildChatRuntimeCapabilities({ available: false }),
    ...(runtimeCapabilities || {})
  });

  const continuityPieces = [
    'Floki develops through persistent memory, emotion, personality, identity, chat-world senses, and honest separation from Minecraft embodiment.'
  ];

  if (formativeMemoryIds.length > 0) {
    continuityPieces.push(`A formative memory was anchored: ${record.content.summary}`);
  }

  if (topTraits.length > 0) {
    continuityPieces.push(`Current strongest tendencies include ${topTraits.join(', ')}.`);
  }

  return normalizeIdentityState({
    updated_at: nowIso(),
    name: 'Floki',
    formation_stage: 'brain_first_terminal',
    self_summary: 'Floki is a persistent digital being with active cognition, a Broca voice, and configured Maker-world webcam sight when a fresh observation is available. Minecraft embodiment remains separate.',
    continuity_summary: continuityPieces.join(' '),
    core_values: [
      'memory',
      'continuity',
      'learning',
      'honesty',
      'friendship',
      'consent',
      'growth',
      ...values
    ],
    self_model: {
      has_body_now: capabilities.has_body_now === true,
      has_eyes_now: capabilities.has_eyes_now === true,
      has_chat_world_webcam_eyes: capabilities.has_chat_world_webcam_eyes === true,
      chat_world_eyes_available_now: capabilities.chat_world_eyes_available_now === true,
      has_game_world_eyes_now: capabilities.has_game_world_eyes_now === true,
      has_cognition_model_now: capabilities.has_cognition_model_now === true,
      has_broca_voice_now: capabilities.has_broca_voice_now === true,
      future_physical_world: 'Minecraft PaperMC 26.1.2 with Java 25',
      current_interface: capabilities.current_interface || 'chat with microphone, speakers, and webcam vision',
      current_sight_scope: capabilities.current_sight_scope || null
    },
    anchors: {
      formative_memory_ids: formativeMemoryIds,
      identity_event_ids: identityEventIds,
      dream_seed_ids: [],
      trusted_names: ['Binary-God']
    },
    boundaries: [
      'do not fake abilities',
      'do not claim Minecraft embodiment before it exists',
      'do not expose private reasoning',
      'Broca is the only speech module'
    ],
    provenance: {
      source_memory_ids: [record.id],
      source_event_ids: identityEventIds,
      safe_summary_only: true
    }
  });
}

function updateFromMemory(record, personalitySummary = {}, options = {}) {
  const delta = identityDeltaFromMemory(
    record,
    personalitySummary,
    options.runtime_capabilities || {}
  );
  return updateIdentity(delta, options);
}

function classifyError(error) {
  const message = error && error.message ? error.message : '';
  const lower = message.toLowerCase();

  if (
    lower.includes('private-reasoning marker') ||
    lower.includes('<think>') ||
    lower.includes('chain_of_thought') ||
    lower.includes('raw_reasoning') ||
    lower.includes('scratchpad')
  ) {
    return 'PINEAL_UNSAFE_DELTA';
  }

  if (message.includes('PINEAL_LOAD_FAILED')) {
    return 'PINEAL_LOAD_FAILED';
  }

  return 'PINEAL_UPDATE_FAILED';
}

function createPineal(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    loadIdentityState: (localOptions = {}) => loadIdentityState({ ...options, ...localOptions }),
    saveIdentityState: (state, localOptions = {}) => saveIdentityState(state, { ...options, ...localOptions }),
    updateIdentity: (delta, localOptions = {}) => updateIdentity(delta, { ...options, ...localOptions }),
    identityDeltaFromMemory,
    updateFromMemory: (record, personalitySummary, localOptions = {}) => updateFromMemory(record, personalitySummary, { ...options, ...localOptions }),
    summarizeIdentity
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  identityPath,
  loadIdentityState,
  saveIdentityState,
  updateIdentity,
  identityDeltaFromMemory,
  updateFromMemory,
  createPineal
};
