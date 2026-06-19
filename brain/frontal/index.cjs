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

const BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS = Object.freeze([
  '- response_intent_for_broca must be one sentence written as direct first-person speech from Floki to the user.',
  '- Use I/me/my/we where appropriate.',
  '- Do not write about Floki in third person.',
  '- Do not begin with "Floki...".',
  '- Do not use "Floki remembers/thinks/feels/wants/is/can/will/should...".',
  '- The sentence should be directly speakable by Broca.'
]);

const COGNITION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'safe_thought_summary',
    'felt_interpretation',
    'memory_links',
    'personality_implications',
    'identity_implications',
    'response_intent_for_broca',
    'new_memory_summary',
    'emotion_reflection_enabled'
  ],
  properties: {
    safe_thought_summary: { type: 'string' },
    felt_interpretation: { type: 'string' },
    memory_links: {
      type: 'array',
      items: { type: 'string' }
    },
    personality_implications: {
      type: 'array',
      items: { type: 'string' }
    },
    identity_implications: {
      type: 'array',
      items: { type: 'string' }
    },
    response_intent_for_broca: { type: 'string' },
    new_memory_summary: { type: 'string' },
    emotion_reflection_enabled: { type: 'boolean' }
  }
});

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Builds cognition packets and calls the configured cognition model for safe reflective cognition summaries.',
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
    { name: 'cognition_completed', description: 'the configured cognition model returned a safe cognition summary.' },
    { name: 'cognition_failed', description: 'the configured cognition model failed or returned unsafe output.' }
  ],
  failure_modes: [
    { code: 'FRONTAL_COGNITION_FAILED', description: 'Model call or validation failed.' },
    { code: 'FRONTAL_UNSAFE_MODEL_OUTPUT', description: 'Model output contained private reasoning markers.' }
  ],
  forbidden: [
    'speech_generation',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Frontal may call the configured cognition model, but stores only safe summaries.'
});

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function getCognitionResponseSchema() {
  return JSON.parse(JSON.stringify(COGNITION_RESPONSE_SCHEMA));
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

function safeText(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().slice(0, 600);
  }

  if (value !== undefined && value !== null) {
    return JSON.stringify(value).slice(0, 600);
  }

  return fallback;
}

function compactCognitionContext(context = {}) {
  const eventText = context &&
    context.event &&
    context.event.payload &&
    typeof context.event.payload.text === 'string'
    ? context.event.payload.text.trim()
    : '';

  const memoryList = Array.isArray(context.memories) ? context.memories : [];
  const compactMemories = memoryList.slice(0, 6).map((memory) => ({
    summary: safeText(memory.summary || memory.text || '', ''),
    tags: Array.isArray(memory.tags) ? memory.tags.slice(0, 8) : [],
    stream: safeText(memory.stream || '', ''),
    category: safeText(memory.category || '', ''),
    reinforcement_score: typeof memory.reinforcement_score === 'number' ? memory.reinforcement_score : 0
  }));

  const persistent = context.persistent_chat_memory || {};
  const emotional = context.emotional_reinforcement || {};
  const dreamMemory = persistent.dream_memory_context || {};
  const webcamVision = context.chat_webcam_vision || {};

  return Object.freeze({
    user_text: eventText.slice(0, 500),
    intent_hint: context.understanding && context.understanding.intent ? context.understanding.intent : null,
    salience: context.salience && context.salience.salience ? context.salience.salience : null,
    affect: context.affect || {},
    recalled_memories: compactMemories,
    persistent_recall_counts: {
      short_term: Array.isArray(persistent.short_term) ? persistent.short_term.length : 0,
      long_term: Array.isArray(persistent.long_term) ? persistent.long_term.length : 0
    },
    dream_memory_context: {
      dream_recall_question: dreamMemory.dream_recall_question === true,
      has_dreams: dreamMemory.has_dreams === true,
      dream_file_reference_available: dreamMemory.dream_file_reference_available === true,
      latest_dream_file: dreamMemory.latest_dream_file || null,
      recent_dreams: Array.isArray(dreamMemory.recent_dreams)
        ? dreamMemory.recent_dreams.slice(0, 3)
        : [],
      dream_memory_matches: Array.isArray(dreamMemory.dream_memory_matches)
        ? dreamMemory.dream_memory_matches.slice(0, 3)
        : [],
      invented_dream: false
    },
    chat_webcam_vision: {
      available: webcamVision.available === true,
      source: webcamVision.source || null,
      sight_scope: webcamVision.sight_scope || null,
      latest_private_observation_timestamp: webcamVision.latest_private_observation_timestamp || null,
      observation_summary: safeText(webcamVision.observation_summary || '', '').slice(0, 500),
      public_transcript_visible: false
    },
    emotional_reinforcement_state: emotional.state || null,
    personality: context.personality || null,
    identity: context.identity || null
  });
}

function buildCognitionPrompt(context) {
  const compact = compactCognitionContext(context);

  return [
    'Generate one safe cognition summary for Floki in chat mode.',
    'The API is constraining your answer with a JSON schema.',
    'Return only values for the required schema fields.',
    'Do not include markdown, comments, private reasoning, or extra keys.',
    '',
    'Field intent:',
    '- safe_thought_summary: short safe reflection about the user request and memory context.',
    '- felt_interpretation: brief grounded emotion interpretation.',
    '- memory_links: array of safe memory connections.',
    '- personality_implications: array of safe personality growth implications.',
    '- identity_implications: array of safe continuity implications.',
    '- response_intent_for_broca: one sentence Broca can later say to the user.',
    '- Current live user request has priority over recalled memories.',
    '- Do not mention recalled topics unless the user directly asked for them.',
    '- For simple greetings or status questions, answer the greeting/status directly.',
    '- Do not drag old proof topics, old test topics, trust, hope, dreams, or transcript topics into the reply unless relevant to the current user text.',
    ...BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS,
    '- If the user asks about dreams, use dream_memory_context as self-continuity.',
    '- If dream_memory_context.has_dreams is false, be honest that I do not have a saved dream yet.',
    '- If dream files or dream memories exist, answer from them; do not invent dreams.',
    '- Keep dream recall first-person: say "I dreamed..." or "I remember the dream as...".',
    '- new_memory_summary: one sentence worth remembering.',
    '- emotion_reflection_enabled: true.',
    '',
    'Compact context:',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

function buildCognitionRetryPrompt(context, previousError) {
  const compact = compactCognitionContext(context);

  return [
    'Your previous response failed JSON/schema validation.',
    'Error: ' + String(previousError || 'unknown').slice(0, 300),
    'Return a valid object matching the enforced schema. No extra keys.',
    'Keep every string short and valid.',
    '',
    'For response_intent_for_broca:',
    ...BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS,
    '',
    'Compact context:',
    JSON.stringify({
      user_text: compact.user_text,
      affect: compact.affect,
      recalled_memories: compact.recalled_memories.slice(0, 3),
      persistent_recall_counts: compact.persistent_recall_counts,
      dream_memory_context: compact.dream_memory_context,
      emotional_reinforcement_state: compact.emotional_reinforcement_state
    }, null, 2)
  ].join('\n');
}

function isJsonParseFailure(error) {
  const message = error && error.message ? error.message : String(error);
  const lower = message.toLowerCase();

  return lower.includes('parseable json') ||
    lower.includes('unterminated string') ||
    lower.includes('expected property name') ||
    lower.includes('json at position') ||
    lower.includes('invalid json') ||
    lower.includes('json schema validation failed');
}

async function generateJsonWithRetry(input, retryInput) {
  try {
    const result = await generateJson(input);

    return Object.freeze({
      result,
      retry_used: false,
      first_error: null
    });
  } catch (firstError) {
    const firstMessage = firstError && firstError.message ? firstError.message : String(firstError);

    if (!isJsonParseFailure(firstError)) {
      throw firstError;
    }

    try {
      const result = await generateJson(retryInput);

      return Object.freeze({
        result,
        retry_used: true,
        first_error: firstMessage
      });
    } catch (secondError) {
      const secondMessage = secondError && secondError.message ? secondError.message : String(secondError);

      throw new Error(
        'schema-constrained cognition JSON failed after retry. first_error=' +
        firstMessage.slice(0, 500) +
        ' second_error=' +
        secondMessage.slice(0, 500)
      );
    }
  }
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

  const normalized = {
    safe_thought_summary: pickString(json, [
      'safe_thought_summary'
    ], 'I am connecting this input to chat memory, trust, hope, personality, identity, and present conversation context.'),

    felt_interpretation: pickString(json, [
      'felt_interpretation'
    ], 'The affect scaffold marks this as meaningful, but reflective emotion is still early and must stay grounded in cognition.'),

    memory_links: asSafeArray(
      json.memory_links,
      'This connects to the importance of persistent memory and continuity.'
    ),

    personality_implications: asSafeArray(
      json.personality_implications,
      'This supports curiosity, trust, continuity, and careful growth.'
    ),

    identity_implications: asSafeArray(
      json.identity_implications,
      'This reinforces Floki\'s continuity, growth, and chat-mode identity.'
    ),

    response_intent_for_broca: pickString(json, [
      'response_intent_for_broca'
    ], 'I can answer naturally from my safe chat cognition summary.'),

    new_memory_summary: pickString(json, [
      'new_memory_summary'
    ], 'Remember that this chat interaction mattered to Floki\'s memory, emotion, and personality growth.'),

    emotion_reflection_enabled: json.emotion_reflection_enabled === true
  };

  rejectPrivateReasoningMarkers(JSON.stringify(normalized), 'normalized cognition JSON');

  if (!normalized.safe_thought_summary || normalized.safe_thought_summary.length < 3) {
    throw new Error('normalized cognition summary was empty');
  }

  if (!normalized.response_intent_for_broca || normalized.response_intent_for_broca.length < 3) {
    throw new Error('normalized Broca intent was empty');
  }

  return normalized;
}

async function runCognition(context, options = {}) {
  try {
    const config = options.model_config || models.getCognitionConfig();
    const schema = getCognitionResponseSchema();

    const generation = await generateJsonWithRetry({
      endpoint: config.endpoint,
      model: config.model,
      prompt: buildCognitionPrompt(context),
      system: 'You are Floki-v2 frontal cognition. Output only a JSON object matching the provided schema.',
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.1,
      top_p: typeof options.top_p === 'number' ? options.top_p : 0.3,
      num_predict: 512,
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false,
      format_schema: schema,
      response_schema: schema
    }, {
      endpoint: config.endpoint,
      model: config.model,
      prompt: buildCognitionRetryPrompt(context, 'first JSON/schema attempt failed'),
      system: 'Repair pass. Output only a compact JSON object matching the provided schema.',
      temperature: 0,
      top_p: 0.1,
      num_predict: 384,
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false,
      format_schema: schema,
      response_schema: schema
    });

    const result = generation.result;
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
        normalized_model_json: true,
        schema_constrained_json: true,
        json_retry_used: generation.retry_used === true,
        json_retry_first_error: generation.first_error || null,
        model_json_fallback_used: false,
        model_json_fallback_reason: null
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'cognition_completed',
        model: result.model,
        schema_constrained_json: true,
        retry_used: generation.retry_used === true,
        fallback_used: false
      }
    });

    persistDiagnostic({
      status: 'cognition_completed',
      output_id: output.id,
      model: result.model,
      schema_constrained_json: true,
      retry_used: generation.retry_used === true,
      fallback_used: false
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
      parent_event_ids: context && context.event && context.event.id ? [context.event.id] : []
    });
  }
}

function createFrontal(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    runCognition: function(context, local = {}) {
      return runCognition(context, { ...options, ...local });
    }
  });
}

module.exports = {
  MODULE_NAME,
  COGNITION_RESPONSE_SCHEMA,
  CONTRACT,
  getContract,
  getCognitionResponseSchema,
  persistDiagnostic,
  safeText,
  compactCognitionContext,
  buildCognitionPrompt,
  buildCognitionRetryPrompt,
  isJsonParseFailure,
  generateJsonWithRetry,
  asSafeString,
  pickString,
  asSafeArray,
  normalizeCognitionJson,
  runCognition,
  createFrontal
};
