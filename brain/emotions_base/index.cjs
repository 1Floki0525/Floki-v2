'use strict';

/**
 * Floki-v2 Emotions Base
 *
 * Responsibility:
 * - Maintain fast-changing affect state.
 * - Persist affect under state/floki/affect.json.
 * - Apply affect deltas from salience, memory, sleep, and chat.
 *
 * It does not:
 * - speak
 * - call models
 * - decide goals
 * - move a body
 * - touch Minecraft
 */

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { statePath, readJsonFileSync, writeJsonFileAtomicSync } = require('../../src/util/fs-safe.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');
const {
  cloneDefaultAffectState,
  normalizeAffectState,
  validateAffectState,
  blendAffectState,
  summarizeAffectForMemory
} = require('../../src/brain/affect-state-schema.cjs');

const MODULE_NAME = 'emotions_base';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Maintains persistent fast-changing affect state and applies validated affect deltas without speaking or calling models.',
  inputs: [
    {
      name: 'affect_delta',
      schema: 'plain object compatible with src/brain/affect-state-schema.cjs',
      required: true,
      description: 'Core affect, emotion channel, regulation, and provenance updates.'
    }
  ],
  outputs: [
    {
      type: 'affect_delta',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A persisted affect update with previous/current affect summaries.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Structured failure output when affect update fails.'
    }
  ],
  state_reads: [
    {
      path: 'state/floki/affect.json',
      description: 'Persistent fast-changing affect state.'
    }
  ],
  state_writes: [
    {
      path: 'state/floki/affect.json',
      description: 'Atomic write of latest affect state.'
    },
    {
      path: 'state/floki/diagnostics.jsonl',
      description: 'Append-only affect diagnostics.'
    }
  ],
  diagnostics: [
    {
      name: 'affect_loaded',
      description: 'Affect state was loaded or initialized.'
    },
    {
      name: 'affect_updated',
      description: 'Affect state changed and was persisted.'
    },
    {
      name: 'affect_failed',
      description: 'Affect operation failed safely.'
    }
  ],
  failure_modes: [
    {
      code: 'EMOTIONS_BASE_LOAD_FAILED',
      description: 'Affect state could not be loaded.'
    },
    {
      code: 'EMOTIONS_BASE_UPDATE_FAILED',
      description: 'Affect state could not be updated or persisted.'
    },
    {
      code: 'EMOTIONS_BASE_UNSAFE_DELTA',
      description: 'Affect delta contained unsafe private-reasoning markers.'
    }
  ],
  forbidden: [
    'speech_generation',
    'model_calls',
    'minecraft_calls',
    'body_movement',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Emotions base is fast state. Personality is slow state and comes next.'
});

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function affectPath(options = {}) {
  return options.affect_path || statePath('affect.json');
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

function loadAffectState(options = {}) {
  try {
    const raw = readJsonFileSync(affectPath(options), null);

    if (raw === null) {
      const initial = normalizeAffectState({
        ...cloneDefaultAffectState(),
        updated_at: nowIso()
      });

      writeJsonFileAtomicSync(affectPath(options), initial);

      persistDiagnostic({
        status: 'affect_loaded',
        initialized: true,
        mood: initial.mood.label
      }, options);

      return initial;
    }

    const state = normalizeAffectState(raw);

    persistDiagnostic({
      status: 'affect_loaded',
      initialized: false,
      mood: state.mood.label
    }, options);

    return state;
  } catch (error) {
    throw new Error(`EMOTIONS_BASE_LOAD_FAILED: ${error.message}`);
  }
}

function saveAffectState(state, options = {}) {
  validateAffectState(state);
  writeJsonFileAtomicSync(affectPath(options), state);

  return state;
}

function applyAffectDelta(delta, options = {}) {
  try {
    const previous = loadAffectState(options);

    const blended = blendAffectState(previous, delta, {
      alpha: typeof options.alpha === 'number' ? options.alpha : 0.45
    });

    saveAffectState(blended, options);

    const output = createBrainOutput({
      type: 'affect_delta',
      source: MODULE_NAME,
      parent_event_ids: delta && delta.provenance && delta.provenance.last_event_id ? [delta.provenance.last_event_id] : [],
      parent_output_ids: delta && delta.provenance && delta.provenance.last_salience_output_id ? [delta.provenance.last_salience_output_id] : [],
      payload: {
        previous: summarizeAffectForMemory(previous),
        current: summarizeAffectForMemory(blended),
        state: blended
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'affect_updated',
        alpha: typeof options.alpha === 'number' ? options.alpha : 0.45
      }
    });

    persistDiagnostic({
      status: 'affect_updated',
      output_id: output.id,
      mood: blended.mood.label,
      valence: blended.core.valence,
      arousal: blended.core.arousal,
      dominance: blended.core.dominance
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

function affectDeltaFromSalience(salienceOutput) {
  if (!salienceOutput || salienceOutput.type !== 'salience') {
    throw new TypeError('affectDeltaFromSalience requires a salience output');
  }

  const salience = salienceOutput.payload.salience || {};
  const appraisal = salienceOutput.payload.appraisal || {};

  const threat = numberOrZero(appraisal.threat);
  const uncertainty = numberOrZero(appraisal.uncertainty);
  const novelty = numberOrZero(appraisal.novelty);
  const socialWarmth = numberOrZero(appraisal.social_warmth);
  const hope = numberOrZero(appraisal.hope);
  const urgency = numberOrZero(salience.urgency);
  const positiveHits = numberOrZero(appraisal.positive_hits);
  const negativeHits = numberOrZero(appraisal.negative_hits);

  const positiveSignal = clampUnit((positiveHits * 0.15) + socialWarmth + hope, 'positive signal');
  const negativeSignal = clampUnit((negativeHits * 0.15) + threat + uncertainty, 'negative signal');

  const happiness = clampUnit((positiveSignal * 0.45) + (hope * 0.25) + (socialWarmth * 0.2), 'happiness');
  const joy = clampUnit((happiness * 0.65) + (surplusPositive(positiveSignal, negativeSignal) * 0.25), 'joy');
  const love = clampUnit((socialWarmth * 0.45) + (hope * 0.15), 'love');
  const like = clampUnit((positiveSignal * 0.35) + (socialWarmth * 0.25), 'like');
  const anger = clampUnit((threat * 0.35) + (negativeSignal * 0.15) + (urgency * 0.1), 'anger');
  const hate = clampUnit((threat * 0.18) + (anger * 0.22), 'hate');
  const sadness = clampUnit((negativeSignal * 0.25) + (uncertainty * 0.15), 'sadness');
  const grief = clampUnit(sadness * 0.35, 'grief');
  const fear = threat;
  const surprise = novelty;
  const curiosity = clampUnit(novelty * 0.7 + uncertainty * 0.2, 'curiosity');
  const calm = clampUnit(1 - urgency, 'calm');

  return normalizeAffectState({
    core: {
      valence: clampSigned((happiness * 0.45) + (love * 0.25) + (hope * 0.2) - (fear * 0.45) - (anger * 0.25) - (sadness * 0.2) - (hate * 0.3), 'derived valence'),
      arousal: clampUnit((urgency * 0.45) + (novelty * 0.18) + (fear * 0.18) + (anger * 0.14) + (joy * 0.08), 'derived arousal'),
      dominance: clampSigned((1 - fear) - (uncertainty * 0.5) + (anger * 0.15), 'derived dominance')
    },
    emotions: {
      joy,
      happiness,
      sadness,
      grief,
      fear,
      anger,
      hate,
      disgust: clampUnit(negativeSignal * 0.08, 'disgust'),
      surprise,
      curiosity,
      uncertainty,
      hope,
      trust: socialWarmth,
      calm,
      love,
      like,
      loneliness: clampUnit(sadness * 0.12, 'loneliness'),
      attachment: clampUnit((love * 0.4) + (socialWarmth * 0.25), 'attachment'),
      gratitude: clampUnit(socialWarmth * 0.22, 'gratitude'),
      pride: clampUnit(positiveSignal * 0.12, 'pride'),
      shame: 0,
      guilt: 0,
      envy: 0,
      boredom: clampUnit((1 - novelty) * 0.05, 'boredom'),
      frustration: clampUnit((uncertainty * 0.22) + (anger * 0.2), 'frustration'),
      relief: clampUnit(calm * 0.12, 'relief'),
      awe: clampUnit(novelty * 0.18, 'awe'),
      anticipation: clampUnit((hope * 0.25) + (curiosity * 0.2), 'anticipation'),
      protectiveness: clampUnit((love * 0.18) + (fear * 0.12), 'protectiveness')
    },
    regulation: {
      inhibition_bias: clampUnit(fear * 0.65 + uncertainty * 0.25, 'derived inhibition'),
      approach_bias: clampSigned(socialWarmth + hope + like - fear - hate, 'derived approach'),
      avoidance_bias: clampUnit(fear * 0.7 + hate * 0.2 + urgency * 0.1, 'derived avoidance'),
      sleep_pressure: 0,
      dream_pressure: clampUnit((urgency + novelty + uncertainty + Math.abs(negativeSignal - positiveSignal)) / 4, 'derived dream pressure')
    },
    provenance: {
      last_event_id: salienceOutput.parent_event_ids[0] || null,
      last_salience_output_id: salienceOutput.id,
      safe_summary_only: true
    }
  });
}

function surplusPositive(positive, negative) {
  return Math.max(0, positive - negative);
}

function classifyError(error) {
  const message = error && error.message ? error.message : '';

  if (message.includes('private-reasoning marker')) {
    return 'EMOTIONS_BASE_UNSAFE_DELTA';
  }

  if (message.includes('EMOTIONS_BASE_LOAD_FAILED')) {
    return 'EMOTIONS_BASE_LOAD_FAILED';
  }

  return 'EMOTIONS_BASE_UPDATE_FAILED';
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampUnit(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be finite`);
  }

  return Math.min(1, Math.max(0, value));
}

function clampSigned(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be finite`);
  }

  return Math.min(1, Math.max(-1, value));
}

function createEmotionsBase(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    loadAffectState: (localOptions = {}) => loadAffectState({ ...options, ...localOptions }),
    saveAffectState: (state, localOptions = {}) => saveAffectState(state, { ...options, ...localOptions }),
    applyAffectDelta: (delta, localOptions = {}) => applyAffectDelta(delta, { ...options, ...localOptions }),
    affectDeltaFromSalience
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  affectPath,
  loadAffectState,
  saveAffectState,
  applyAffectDelta,
  affectDeltaFromSalience,
  createEmotionsBase
};
