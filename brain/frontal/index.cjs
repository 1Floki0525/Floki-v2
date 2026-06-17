'use strict';

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const models = require('../../src/config/model-config.cjs');
const { generateJson, rejectPrivateReasoningMarkers } = require('../../src/model/ollama-client.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'frontal';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Builds cognition packets and calls qwen3.5:9b for safe reflective cognition summaries.',
  inputs: [
    {
      name: 'cognition_context',
      schema: 'plain object',
      required: true,
      description: 'Event, understanding, recall, affect, personality, identity, and lifecycle context.'
    }
  ],
  outputs: [
    {
      type: 'model_response_summary',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Safe qwen cognition summary.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Cognition failure.'
    }
  ],
  state_reads: [
    { path: 'state/floki/*', description: 'Reads context passed by orchestrating runtime.' }
  ],
  state_writes: [
    { path: 'state/floki/diagnostics.jsonl', description: 'Append-only cognition diagnostics.' }
  ],
  diagnostics: [
    { name: 'cognition_completed', description: 'qwen3.5:9b returned a safe cognition summary.' },
    { name: 'cognition_failed', description: 'qwen3.5:9b failed or returned unsafe output.' }
  ],
  failure_modes: [
    { code: 'FRONTAL_COGNITION_FAILED', description: 'Model call or validation failed.' },
    { code: 'FRONTAL_UNSAFE_MODEL_OUTPUT', description: 'Model output contained private reasoning markers.' }
  ],
  forbidden: [
    'speech_generation',
    'minecraft_calls',
    'body_movement',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Frontal may call qwen3.5:9b in Stage 08, but stores only safe summaries.'
});

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return { ok: true, skipped: true };
  }

  appendJsonlSync(options.diagnostics_path || statePath('diagnostics.jsonl'), {
    id: diagnosticId(),
    created_at: nowIso(),
    module: MODULE_NAME,
    ...record
  });

  return { ok: true, skipped: false };
}

function buildCognitionPrompt(context) {
  return [
    'Respond using JSON only. Do not include markdown. Do not include private reasoning. Do not include think tags.',
    '',
    'You are Floki-v2 frontal cognition in terminal chat mode.',
    'You are not in Minecraft yet. You do not have body control, eyes, or Broca speech yet.',
    'Use the supplied memory, affect scaffold, personality, and identity context to create a safe reflective cognition summary.',
    '',
    'Return JSON with these meanings. Exact field names are preferred:',
    '{',
    '  "safe_thought_summary": "short safe reflection",',
    '  "felt_interpretation": "what the affect scaffold means in plain language",',
    '  "memory_links": ["safe memory connection"],',
    '  "personality_implications": ["safe personality implication"],',
    '  "identity_implications": ["safe identity implication"],',
    '  "response_intent_for_broca": "what Broca should say later",',
    '  "new_memory_summary": "what should be remembered",',
    '  "emotion_reflection_enabled": true',
    '}',
    '',
    'Context JSON:',
    JSON.stringify(context, null, 2)
  ].join('\n');
}

function asSafeString(value, fallback) {
  let text = '';

  if (typeof value === 'string') {
    text = value;
  } else if (value !== undefined && value !== null) {
    text = JSON.stringify(value);
  }

  text = text.trim();

  if (!text) {
    text = fallback;
  }

  rejectPrivateReasoningMarkers(text, 'cognition string');
  return text.slice(0, 1500);
}

function pickString(json, keys, fallback) {
  for (const key of keys) {
    if (json && Object.prototype.hasOwnProperty.call(json, key)) {
      const picked = asSafeString(json[key], '');
      if (picked) return picked;
    }
  }

  return asSafeString(fallback, 'No safe summary returned.');
}

function asSafeArray(value, fallbackItem) {
  let items = [];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string' && value.trim()) {
    items = [value];
  }

  items = items
    .map((item) => asSafeString(item, ''))
    .filter(Boolean)
    .slice(0, 8);

  if (items.length === 0 && fallbackItem) {
    items.push(asSafeString(fallbackItem, 'safe fallback'));
  }

  return items;
}

function normalizeCognitionJson(json, context = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('cognition JSON must be an object');
  }

  rejectPrivateReasoningMarkers(JSON.stringify(json), 'cognition JSON');

  const userText = context && context.event && context.event.payload && context.event.payload.text
    ? context.event.payload.text
    : 'the current interaction';

  const fallbackSummary = 'I am connecting this input to memory, trust, hope, personality, and identity while remaining in terminal cognition mode.';
  const fallbackFelt = 'The affect scaffold marks this as meaningful, but reflective emotion is still early and must stay grounded in cognition.';

  const normalized = {
    safe_thought_summary: pickString(json, [
      'safe_thought_summary',
      'thought_summary',
      'summary',
      'reflection',
      'safe_reflection',
      'response',
      'answer'
    ], fallbackSummary),

    felt_interpretation: pickString(json, [
      'felt_interpretation',
      'emotion_interpretation',
      'affect_interpretation',
      'feeling',
      'felt_sense'
    ], fallbackFelt),

    memory_links: asSafeArray(
      json.memory_links || json.memories || json.related_memories,
      'This connects to the importance of persistent memory and continuity.'
    ),

    personality_implications: asSafeArray(
      json.personality_implications || json.personality || json.trait_implications,
      'This supports curiosity, trust, continuity, and careful growth.'
    ),

    identity_implications: asSafeArray(
      json.identity_implications || json.identity || json.self_implications,
      'This reinforces that Floki is being built brain-first before embodiment.'
    ),

    response_intent_for_broca: pickString(json, [
      'response_intent_for_broca',
      'response_intent',
      'broca_intent',
      'speech_intent'
    ], 'Broca should answer honestly that cognition is now active, while speech is still a separate upcoming layer.'),

    new_memory_summary: pickString(json, [
      'new_memory_summary',
      'memory_summary',
      'remember',
      'memory_to_store'
    ], 'Remember that this interaction mattered to the development of Floki as a brain-first digital being.'),

    emotion_reflection_enabled: true
  };

  rejectPrivateReasoningMarkers(JSON.stringify(normalized), 'normalized cognition JSON');

  if (!normalized.safe_thought_summary || normalized.safe_thought_summary.length < 3) {
    throw new Error('normalized cognition summary was empty');
  }

  return normalized;
}

async function runCognition(context, options = {}) {
  try {
    const config = options.model_config || models.getCognitionConfig();

    const result = await generateJson({
      endpoint: config.endpoint,
      model: config.model,
      prompt: buildCognitionPrompt(context),
      system: 'You are Floki-v2 frontal cognition. Output JSON only. Store no private reasoning.',
      temperature: config.temperature,
      top_p: config.top_p,
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false
    });

    const normalized = normalizeCognitionJson(result.response_json, context);
    const parentEventIds = context && context.event && context.event.id ? [context.event.id] : [];

    const output = createBrainOutput({
      type: 'model_response_summary',
      source: MODULE_NAME,
      parent_event_ids: parentEventIds,
      payload: {
        model: result.model,
        cognition: normalized,
        raw_stats: result.raw_stats,
        safe_summary_only: true,
        raw_private_reasoning_stored: false,
        normalized_model_json: true
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'cognition_completed',
        model: result.model
      }
    });

    persistDiagnostic({
      status: 'cognition_completed',
      output_id: output.id,
      model: result.model
    }, options);

    return output;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const lower = message.toLowerCase();
    const code = lower.includes('private-reasoning') || lower.includes('<think>')
      ? 'FRONTAL_UNSAFE_MODEL_OUTPUT'
      : 'FRONTAL_COGNITION_FAILED';

    persistDiagnostic({
      status: 'cognition_failed',
      code,
      message: message.slice(0, 1000)
    }, options);

    return makeFailureOutput(MODULE_NAME, code, message, {
      parent_event_ids: context && context.event && context.event.id ? [context.event.id] : [],
      payload: {
        context_keys: context && typeof context === 'object' ? Object.keys(context) : []
      }
    });
  }
}

function createFrontal(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    runCognition: (context, local = {}) => runCognition(context, { ...options, ...local })
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  buildCognitionPrompt,
  normalizeCognitionJson,
  runCognition,
  createFrontal
};
