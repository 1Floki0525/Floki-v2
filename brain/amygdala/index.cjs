'use strict';

/**
 * Floki-v2 Amygdala
 *
 * Responsibility:
 * - Estimate salience, urgency, threat, surprise, uncertainty, and hope.
 * - Produce salience outputs that emotions_base can turn into affect changes.
 *
 * Current stage uses deterministic appraisal heuristics.
 * qwen cognition can later add richer interpretation, but this module must remain honest.
 */

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { validateBrainEvent } = require('../../src/brain/brain-event-schema.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'amygdala';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Computes event salience, urgency, threat, surprise, uncertainty, and hope without speaking, planning, or calling models.',
  inputs: [
    {
      name: 'brain_event',
      schema: 'src/brain/brain-event-schema.cjs',
      required: true,
      description: 'Validated brain event.'
    }
  ],
  outputs: [
    {
      type: 'salience',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Salience and appraisal values for emotions_base/frontal/hippocampus.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Structured failure output when salience cannot be computed safely.'
    }
  ],
  state_reads: [
    {
      path: 'none',
      description: 'Stage 06 amygdala is deterministic and stateless.'
    }
  ],
  state_writes: [
    {
      path: 'state/floki/diagnostics.jsonl',
      description: 'Append-only salience diagnostics.'
    }
  ],
  diagnostics: [
    {
      name: 'salience_computed',
      description: 'A validated event received an appraisal/salience output.'
    },
    {
      name: 'salience_failed',
      description: 'Salience computation failed safely.'
    }
  ],
  failure_modes: [
    {
      code: 'AMYGDALA_INVALID_EVENT',
      description: 'Input event failed validation.'
    },
    {
      code: 'AMYGDALA_UNSAFE_CONTENT',
      description: 'Input content contained banned private-reasoning markers.'
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
  notes: 'Amygdala is a salience/appraisal module. It does not own personality and does not speak.'
});

const NEGATIVE_TERMS = Object.freeze([
  'afraid',
  'fear',
  'scared',
  'danger',
  'threat',
  'hurt',
  'attack',
  'death',
  'die',
  'lost',
  'alone',
  'abandoned',
  'angry',
  'anger',
  'hate',
  'hateful',
  'sad',
  'sadness',
  'cry',
  'grief',
  'grieving',
  'broken',
  'error',
  'fail',
  'failed',
  'unsafe',
  'frustrated',
  'frustration'
]);

const POSITIVE_TERMS = Object.freeze([
  'good',
  'safe',
  'trust',
  'friend',
  'love',
  'loving',
  'like',
  'happy',
  'happiness',
  'joy',
  'hope',
  'dream',
  'learn',
  'build',
  'remember',
  'alive',
  'curious',
  'proud',
  'gratitude',
  'thankful'
]);

const NOVELTY_TERMS = Object.freeze([
  'new',
  'first',
  'fresh',
  'unknown',
  'strange',
  'discover',
  'learn',
  'wonder',
  'curious',
  'why',
  'how'
]);

const UNCERTAINTY_TERMS = Object.freeze([
  'maybe',
  'uncertain',
  'confused',
  'unsure',
  'unknown',
  'guess',
  'probably',
  'could',
  'might',
  '?'
]);

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return {
      ok: true,
      skipped: true
    };
  }

  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), {
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

function rejectUnsafeEventContent(event) {
  const lower = JSON.stringify(event).toLowerCase();

  for (const marker of ['<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad']) {
    if (lower.includes(marker)) {
      throw new Error(`AMYGDALA_UNSAFE_CONTENT: event contains banned private-reasoning marker ${marker}`);
    }
  }

  return true;
}

function computeSalience(event, options = {}) {
  validateBrainEvent(event);
  rejectUnsafeEventContent(event);

  const text = eventText(event);
  const lowered = text.toLowerCase();

  const negativeHits = countHits(lowered, NEGATIVE_TERMS);
  const positiveHits = countHits(lowered, POSITIVE_TERMS);
  const noveltyHits = countHits(lowered, NOVELTY_TERMS);
  const uncertaintyHits = countHits(lowered, UNCERTAINTY_TERMS);

  const threat = clamp01((negativeHits * 0.18) + explicitThreatBoost(event));
  const socialWarmth = clamp01((positiveHits * 0.12) + socialWarmthBoost(event));
  const novelty = clamp01((noveltyHits * 0.18) + noveltyBoost(event));
  const uncertainty = clamp01((uncertaintyHits * 0.16) + uncertaintyBoost(event));
  const hope = clamp01((positiveHits * 0.1) + hopeBoost(event));

  const urgency = clamp01(
    (threat * 0.45) +
    (uncertainty * 0.2) +
    (novelty * 0.15) +
    eventTypeUrgency(event)
  );

  const attentionPriority = clamp01(
    (urgency * 0.45) +
    (novelty * 0.2) +
    (socialWarmth * 0.15) +
    (hope * 0.1) +
    eventTypePriority(event)
  );

  const salienceOutput = createBrainOutput({
    type: 'salience',
    source: MODULE_NAME,
    parent_event_ids: [event.id],
    payload: {
      event_id: event.id,
      event_type: event.type,
      appraisal: {
        threat,
        social_warmth: socialWarmth,
        novelty,
        uncertainty,
        hope,
        negative_hits: negativeHits,
        positive_hits: positiveHits,
        novelty_hits: noveltyHits,
        uncertainty_hits: uncertaintyHits
      },
      salience: {
        urgency,
        attention_priority: attentionPriority,
        memory_importance_hint: memoryImportanceHint({
          threat,
          socialWarmth,
          novelty,
          uncertainty,
          hope,
          urgency,
          attentionPriority
        })
      },
      action_tendency: deriveActionTendency({
        threat,
        socialWarmth,
        novelty,
        uncertainty,
        hope,
        urgency
      }),
      safe_summary_only: true
    },
    diagnostics: {
      module: MODULE_NAME,
      status: 'salience_computed',
      deterministic_stage: true
    }
  });

  persistDiagnostic({
    status: 'salience_computed',
    event_id: event.id,
    event_type: event.type,
    urgency,
    attention_priority: attentionPriority,
    memory_importance_hint: salienceOutput.payload.salience.memory_importance_hint
  }, options);

  return salienceOutput;
}

function safeComputeSalience(event, options = {}) {
  try {
    return computeSalience(event, options);
  } catch (error) {
    const failure = makeFailureOutput(
      MODULE_NAME,
      classifyError(error),
      error.message,
      {
        parent_event_ids: event && event.id ? [event.id] : [],
        payload: {
          event_type: event && event.type ? event.type : null
        }
      }
    );

    try {
      persistDiagnostic({
        status: 'salience_failed',
        failure_code: failure.failure.code,
        message: error.message
      }, options);
    } catch (_) {
      return failure;
    }

    return failure;
  }
}

function eventText(event) {
  if (event.payload && typeof event.payload.text === 'string') {
    return event.payload.text;
  }

  return JSON.stringify(event.payload || {});
}

function countHits(text, terms) {
  let count = 0;

  for (const term of terms) {
    if (term === '?') {
      if (text.includes('?')) count += 1;
      continue;
    }

    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    if (pattern.test(text)) {
      count += 1;
    }
  }

  return count;
}

function explicitThreatBoost(event) {
  if (event.type === 'safety_interruption') return 0.7;
  if (event.type === 'diagnostic') return 0.1;
  return 0;
}

function socialWarmthBoost(event) {
  if (event.source === 'user' && event.type === 'user_text') return 0.08;
  return 0;
}

function noveltyBoost(event) {
  if (event.type === 'user_text') return 0.08;
  if (event.type === 'vision_static_png') return 0.18;
  return 0;
}

function uncertaintyBoost(event) {
  if (event.modality === 'vision') return 0.12;
  return 0;
}

function hopeBoost(event) {
  const text = eventText(event).toLowerCase();
  if (text.includes('dream') || text.includes('hope') || text.includes('build')) return 0.2;
  return 0;
}

function eventTypeUrgency(event) {
  if (event.type === 'safety_interruption') return 0.55;
  if (event.type === 'affect_update') return 0.18;
  if (event.type === 'user_text') return 0.12;
  return 0.05;
}

function eventTypePriority(event) {
  if (event.type === 'user_text') return 0.2;
  if (event.type === 'safety_interruption') return 0.35;
  if (event.type === 'memory_recall') return 0.12;
  return 0.05;
}

function memoryImportanceHint(values) {
  return clamp01(
    0.35 +
    (values.attentionPriority * 0.3) +
    (values.urgency * 0.2) +
    (values.threat * 0.15) +
    (values.hope * 0.1)
  );
}

function deriveActionTendency(values) {
  if (values.threat >= 0.65) return 'avoid_or_seek_safety';
  if (values.uncertainty >= 0.65) return 'pause_and_clarify';
  if (values.socialWarmth >= 0.55 || values.hope >= 0.55) return 'approach_and_engage';
  if (values.novelty >= 0.55) return 'orient_and_explore';
  if (values.urgency >= 0.55) return 'increase_attention';

  return 'observe';
}

function classifyError(error) {
  const message = error && error.message ? error.message : '';
  const lower = message.toLowerCase();

  if (
    message.includes('AMYGDALA_UNSAFE_CONTENT') ||
    lower.includes('banned reasoning marker') ||
    lower.includes('banned private-reasoning marker') ||
    lower.includes('<think>') ||
    lower.includes('</think>') ||
    lower.includes('chain_of_thought') ||
    lower.includes('hidden_reasoning') ||
    lower.includes('raw_reasoning') ||
    lower.includes('scratchpad')
  ) {
    return 'AMYGDALA_UNSAFE_CONTENT';
  }

  return 'AMYGDALA_INVALID_EVENT';
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createAmygdala(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    computeSalience: (event, localOptions = {}) => computeSalience(event, { ...options, ...localOptions }),
    safeComputeSalience: (event, localOptions = {}) => safeComputeSalience(event, { ...options, ...localOptions })
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  computeSalience,
  safeComputeSalience,
  createAmygdala
};
