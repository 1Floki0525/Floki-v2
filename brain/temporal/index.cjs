'use strict';

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { validateBrainEvent } = require('../../src/brain/brain-event-schema.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'temporal';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Builds safe language understanding summaries from validated text events before cognition.',
  inputs: [{ name: 'brain_event', schema: 'src/brain/brain-event-schema.cjs', required: true, description: 'Validated user/system text event.' }],
  outputs: [{ type: 'understanding', schema: 'src/brain/brain-output-schema.cjs', description: 'Safe language-understanding summary.' }, { type: 'failure', schema: 'src/brain/brain-output-schema.cjs', description: 'Failure output.' }],
  state_reads: [{ path: 'none', description: 'Stage 08 temporal is deterministic and stateless.' }],
  state_writes: [{ path: 'state/floki/diagnostics.jsonl', description: 'Append-only diagnostics.' }],
  diagnostics: [{ name: 'understanding_created', description: 'Language understanding was created.' }],
  failure_modes: [{ code: 'TEMPORAL_INVALID_EVENT', description: 'Input event failed validation.' }],
  forbidden: ['speech_generation', 'minecraft_calls', 'body_movement', 'private_reasoning_storage', 'fake_success'],
  notes: 'Temporal does not call qwen directly in Stage 08; frontal owns cognition call.'
});

function getContract() { validateModuleContract(CONTRACT); return CONTRACT; }

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) return { ok: true, skipped: true };
  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), { id: diagnosticId(), created_at: nowIso(), module: MODULE_NAME, ...record });
  return { ok: true, skipped: false };
}

function eventText(event) {
  if (event.payload && typeof event.payload.text === 'string') return event.payload.text;
  return JSON.stringify(event.payload || {});
}

function inferIntent(text) {
  const lower = text.toLowerCase();
  if (lower.includes('?')) return 'question';
  if (lower.includes('remember')) return 'memory_instruction';
  if (lower.includes('feel') || lower.includes('fear') || lower.includes('love') || lower.includes('hate')) return 'emotion_discussion';
  if (lower.includes('build') || lower.includes('fix') || lower.includes('make')) return 'development_instruction';
  return 'conversation';
}

function understandEvent(event, options = {}) {
  try {
    validateBrainEvent(event);
    const text = eventText(event);
    const words = text.trim().split(/\s+/).filter(Boolean);
    const output = createBrainOutput({
      type: 'understanding',
      source: MODULE_NAME,
      parent_event_ids: [event.id],
      payload: {
        event_id: event.id,
        text_summary: text.slice(0, 500),
        intent_hint: inferIntent(text),
        word_count: words.length,
        addressed_to_floki: /\bfloki\b/i.test(text),
        safe_summary_only: true
      },
      diagnostics: { module: MODULE_NAME, status: 'understanding_created' }
    });
    persistDiagnostic({ status: 'understanding_created', event_id: event.id, intent_hint: output.payload.intent_hint }, options);
    return output;
  } catch (error) {
    return makeFailureOutput(MODULE_NAME, 'TEMPORAL_INVALID_EVENT', error.message, { parent_event_ids: event && event.id ? [event.id] : [] });
  }
}

function createTemporal(options = {}) {
  return Object.freeze({ module: MODULE_NAME, contract: getContract(), understandEvent: (event, local = {}) => understandEvent(event, { ...options, ...local }) });
}

module.exports = { MODULE_NAME, CONTRACT, getContract, understandEvent, createTemporal };
