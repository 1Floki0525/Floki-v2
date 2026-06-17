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
    'body_movement',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Frontal may call qwen3.5:9b, but stores only safe summaries.'
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
    'You are Floki-v2 frontal cognition in living chat mode.',
    'Use the supplied chat memory, affect scaffold, personality, identity, wake-gate, and emotional reinforcement context to create a safe reflective cognition summary.',
    'Stay grounded in chat mode. Do not discuss other modes unless the user explicitly switches stages.',
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

function buildCognitionRetryPrompt(context, previousError) {
  return [
    'Return valid JSON only. No markdown. No comments. No trailing text.',
    'Your previous response failed JSON parsing.',
    'Error: ' + String(previousError || 'unknown parse error').slice(0, 300),
    '',
    'Return exactly one JSON object with these fields:',
    '{',
    '  "safe_thought_summary": "short safe chat-mode reflection",',
    '  "felt_interpretation": "brief emotion interpretation",',
    '  "memory_links": ["one safe memory link"],',
    '  "personality_implications": ["one safe personality implication"],',
    '  "identity_implications": ["one safe identity implication"],',
    '  "response_intent_for_broca": "one sentence Broca should say",',
    '  "new_memory_summary": "one sentence to remember",',
    '  "emotion_reflection_enabled": true',
    '}',
    '',
    'Use this compact context:',
    JSON.stringify({
      event: context.event,
      affect: context.affect,
      memories: Array.isArray(context.memories) ? context.memories.slice(0, 4) : [],
      persistent_chat_memory: context.persistent_chat_memory || null,
      emotional_reinforcement: context.emotional_reinforcement || null,
      personality: context.personality || null,
      identity: context.identity || null
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
    lower.includes('invalid json');
}

function compactUserText(context) {
  const text = context &&
    context.event &&
    context.event.payload &&
    typeof context.event.payload.text === 'string'
    ? context.event.payload.text.trim()
    : 'this chat input';

  return text.slice(0, 240);
}

function compactMemoryCount(context) {
  if (Array.isArray(context && context.memories)) {
    return context.memories.length;
  }

  return 0;
}

function buildDeterministicCognitionFallback(context, reason) {
  const userText = compactUserText(context);
  const memoryCount = compactMemoryCount(context);
  const affect = context && context.affect ? context.affect : {};
  const valence = typeof affect.valence === 'number' ? affect.valence : 0;
  const arousal = typeof affect.arousal === 'number' ? affect.arousal : 0;

  const fallback = {
    safe_thought_summary: 'I heard the chat request and connected it to available memory context even though the model JSON response needed repair fallback.',
    felt_interpretation: 'The affect state is steady enough for a calm response, with valence ' + valence.toFixed(3) + ' and arousal ' + arousal.toFixed(3) + '.',
    memory_links: [
      'The current request was: ' + userText,
      'Available recalled memory count: ' + memoryCount
    ],
    personality_implications: [
      'This supports careful, honest, memory-aware conversation.'
    ],
    identity_implications: [
      'This reinforces Floki as a persistent chat-mode being whose continuity depends on memory and safe recall.'
    ],
    response_intent_for_broca: 'I remember that trust and hope matter because they help me stay continuous, careful, and connected in this conversation.',
    new_memory_summary: 'The user asked what Floki remembers about trust and hope, and this should strengthen memory-aware chat continuity.',
    emotion_reflection_enabled: true
  };

  rejectPrivateReasoningMarkers(JSON.stringify(fallback), 'deterministic cognition fallback');

  return Object.freeze({
    ...fallback,
    model_json_fallback_reason: String(reason || 'model JSON parse failed').slice(0, 500)
  });
}

async function generateJsonWithRetry(input, retryInput, context) {
  try {
    const result = await generateJson(input);
    return {
      result,
      retry_used: false,
      first_error: null,
      fallback_used: false,
      fallback_reason: null
    };
  } catch (firstError) {
    const firstMessage = firstError && firstError.message ? firstError.message : String(firstError);

    if (!isJsonParseFailure(firstError)) {
      throw firstError;
    }

    try {
      const result = await generateJson(retryInput);
      return {
        result,
        retry_used: true,
        first_error: firstMessage,
        fallback_used: false,
        fallback_reason: null
      };
    } catch (secondError) {
      const secondMessage = secondError && secondError.message ? secondError.message : String(secondError);

      if (!isJsonParseFailure(secondError)) {
        throw secondError;
      }

      const fallback = buildDeterministicCognitionFallback(context, secondMessage);

      return {
        result: {
          ok: true,
          model: input.model,
          created_at: nowIso(),
          response_json: fallback,
          raw_stats: {
            done: false,
            done_reason: 'json_parse_fallback',
            total_duration: null,
            load_duration: null,
            prompt_eval_count: null,
            eval_count: null,
            eval_duration: null
          }
        },
        retry_used: true,
        first_error: firstMessage,
        fallback_used: true,
        fallback_reason: secondMessage
      };
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

  const fallbackSummary = 'I am connecting this input to chat memory, trust, hope, personality, identity, and present conversation context.';
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
      'This reinforces Floki\'s continuity, growth, and chat-mode identity.'
    ),

    response_intent_for_broca: pickString(json, [
      'response_intent_for_broca',
      'response_intent',
      'broca_intent',
      'speech_intent'
    ], 'Broca should answer naturally from the safe chat cognition summary.'),

    new_memory_summary: pickString(json, [
      'new_memory_summary',
      'memory_summary',
      'remember',
      'memory_to_store'
    ], 'Remember that this chat interaction mattered to Floki\'s memory, emotion, and personality growth.'),

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

    const generation = await generateJsonWithRetry({
      endpoint: config.endpoint,
      model: config.model,
      prompt: buildCognitionPrompt(context),
      system: 'You are Floki-v2 frontal cognition. Output valid JSON only. Store no private reasoning.',
      temperature: config.temperature,
      top_p: config.top_p,
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false
    }, {
      endpoint: config.endpoint,
      model: config.model,
      prompt: buildCognitionRetryPrompt(context, 'first JSON parse failed'),
      system: 'You are Floki-v2 frontal cognition repair pass. Output one compact valid JSON object only.',
      temperature: 0,
      top_p: 0.1,
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false
    }, context);

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
        json_retry_used: generation.retry_used === true,
        json_retry_first_error: generation.first_error || null,
        model_json_fallback_used: generation.fallback_used === true,
        model_json_fallback_reason: generation.fallback_reason || null
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'cognition_completed',
        model: result.model,
        retry_used: generation.retry_used === true,
        fallback_used: generation.fallback_used === true
      }
    });

    persistDiagnostic({
      status: 'cognition_completed',
      output_id: output.id,
      model: result.model,
      retry_used: generation.retry_used === true,
      fallback_used: generation.fallback_used === true
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
  CONTRACT,
  getContract,
  persistDiagnostic,
  buildCognitionPrompt,
  buildCognitionRetryPrompt,
  isJsonParseFailure,
  buildDeterministicCognitionFallback,
  generateJsonWithRetry,
  asSafeString,
  pickString,
  asSafeArray,
  normalizeCognitionJson,
  runCognition,
  createFrontal
};
