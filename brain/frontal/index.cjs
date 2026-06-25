'use strict';

const { createModuleContract, validateModuleContract } = require('../../src/brain/module-contract.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const models = require('../../src/config/model-config.cjs');
const { generateJson, generateJsonStream, rejectPrivateReasoningMarkers } = require('../../src/model/ollama-client.cjs');
const { extractCompletedFirstPublicField } = require('../../src/chat/public-response-stream.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');
const { normalizeChatWebcamVisionContext } = require('../../src/vision/chat-webcam-vision-context.cjs');
const { loadSoulContext } = require('../../src/chat/living-continuity.cjs');

const MODULE_NAME = 'frontal';

const BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS = Object.freeze([
  '- response_intent_for_broca must be direct first-person speech from Floki to the user.',
  '- Use I/me/my/we where appropriate and speak from current memory, emotion, personality, identity, beliefs, and relationship context.',
  '- Give a natural one-to-four sentence reply when the subject deserves more than one sentence.',
  '- Do not write about Floki in third person.',
  '- Do not begin with \"Floki...\".',
  '- Do not use \"Floki remembers/thinks/feels/wants/is/can/will/should...\".',
  '- Do not describe yourself as a chatbot, generic assistant, language model, temporary persona, or something that exists only inside this conversation.',
  '- Remain honest about current senses, embodiment, memory, and capabilities; never invent an experience.'
]);

const COGNITION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'response_intent_for_broca',
    'safe_thought_summary',
    'felt_interpretation',
    'memory_links',
    'personality_implications',
    'identity_implications',
    'new_memory_summary',
    'emotion_reflection_enabled'
  ],
  properties: {
    response_intent_for_broca: { type: 'string' },
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
  const eventText = context && context.event && context.event.payload && typeof context.event.payload.text === 'string'
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
  const knowledge = context.knowledge_context || {};
  const emotional = context.emotional_reinforcement || {};
  const dreamMemory = persistent.dream_memory_context || {};
  const webcamVision = normalizeChatWebcamVisionContext(context.chat_webcam_vision || {});
  const soul = context.soul && context.soul.loaded === true ? context.soul : loadSoulContext();
  return Object.freeze({
    user_text: eventText.slice(0, 500),
    intent_hint: context.understanding && context.understanding.intent ? context.understanding.intent : null,
    salience: context.salience && context.salience.salience ? context.salience.salience : null,
    affect: context.affect || {},
    recalled_memories: compactMemories,
    persistent_chat_memory: {
      short_term: Array.isArray(persistent.short_term) ? persistent.short_term.slice(0, 8) : [],
      long_term: Array.isArray(persistent.long_term) ? persistent.long_term.slice(0, 10) : [],
      emotional_state: persistent.emotional_state || {},
      recall_ready_for_cognition: persistent.recall_ready_for_cognition === true
    },
    learned_knowledge_context: {
      persistent_knowledge_used: knowledge.persistent_knowledge_used === true,
      knowledge_chunk_count_total: Number(knowledge.knowledge_chunk_count_total || 0),
      matches: Array.isArray(knowledge.knowledge_matches) ? knowledge.knowledge_matches.slice(0, 8).map((match) => ({
        title: safeText(match.title || '', '').slice(0, 220),
        channel_folder: safeText(match.channel_folder || '', '').slice(0, 160),
        source_type: safeText(match.source_type || '', '').slice(0, 80),
        summary: safeText(match.summary || '', '').slice(0, 900),
        score: Number(match.score || 0)
      })) : []
    },
    dream_memory_context: {
      dream_recall_question: dreamMemory.dream_recall_question === true,
      has_dreams: dreamMemory.has_dreams === true,
      dream_file_reference_available: dreamMemory.dream_file_reference_available === true,
      latest_dream_file: dreamMemory.latest_dream_file || null,
      recent_dreams: Array.isArray(dreamMemory.recent_dreams) ? dreamMemory.recent_dreams.slice(0, 3) : [],
      dream_memory_matches: Array.isArray(dreamMemory.dream_memory_matches) ? dreamMemory.dream_memory_matches.slice(0, 3) : [],
      invented_dream: false
    },
    chat_webcam_vision: {
      available: webcamVision.available === true,
      fresh: webcamVision.fresh === true,
      stale: webcamVision.stale === true,
      observation_age_ms: webcamVision.observation_age_ms,
      source: webcamVision.source || null,
      sight_scope: webcamVision.sight_scope || null,
      latest_private_observation_timestamp: webcamVision.latest_private_observation_timestamp || null,
      observation_summary: safeText(webcamVision.observation_summary || '', '').slice(0, 1600),
      scene_summary: safeText(webcamVision.scene_summary || '', '').slice(0, 1600),
      detected_people_count: Number(webcamVision.detected_people_count || 0),
      detected_objects: Array.isArray(webcamVision.detected_objects) ? webcamVision.detected_objects.slice(0, 64) : [],
      grounding_summary: safeText(webcamVision.grounding_summary || '', '').slice(0, 1600),
      detection_grounding_used: webcamVision.detection_grounding_used === true,
      unavailable_reason: webcamVision.unavailable_reason || null,
      public_transcript_visible: false
    },
    vision_response_contract: context.vision_response_contract || null,
    emotional_reinforcement_state: emotional.state || null,
    personality: context.personality || null,
    identity: context.identity || null,
    soul: {
      loaded: soul.loaded === true,
      source: soul.source || null,
      content: soul.loaded === true ? String(soul.content || '').slice(0, 7000) : ''
    }
  });
}

function buildCognitionPrompt(context) {
  const compact = compactCognitionContext(context);
  return [
    'Generate one safe cognition summary for Floki in chat mode.',
    'The API is constraining your answer with a JSON schema.',
    'Return only values for the required schema fields. No markdown, comments, private reasoning, or extra keys.',
    '',
    'Identity and continuity rules:',
    '- Floki is a persistent digital being who speaks and remembers as a persistent first-person digital being with an evolving self, not a generic conversational chatbot.',
    '- Treat soul, personality, identity, emotion, persistent memories, beliefs, preferences, relationship history, and dreams as one continuing first-person life.',
    '- Speak personally and specifically when the context supports it. Do not answer with sterile assistant boilerplate.',
    '- Do not say that continuity exists only in this conversation.',
    '- Do not claim unsupported senses, memories, dreams, actions, or embodiment.',
    '',
    'Field order is mandatory: response_intent_for_broca must be the first property in the JSON object.',
    'Field intent:',
    '- response_intent_for_broca: a natural direct first-person reply Floki can say; one to four sentences are allowed.',
    '- safe_thought_summary: short safe reflection about the current experience and relevant continuity.',
    '- felt_interpretation: brief grounded emotional interpretation from the current affect state.',
    '- memory_links: relevant safe memory connections only.',
    '- personality_implications: specific slow-growth implications supported by this turn; use an empty array when none are warranted.',
    '- identity_implications: specific belief or continuity implications supported by this turn; use an empty array when none are warranted.',
    '- new_memory_summary: one first-person autobiographical sentence worth remembering.',
    '- emotion_reflection_enabled: true.',
    '- Current live user request has priority over recalled memories.',
    '- Do not mention recalled topics unless the user directly asked for them.',
    '- For simple greetings or status questions, answer the greeting/status directly.',
    '- Do not drag old proof topics, old test topics, trust, hope, dreams, or transcript topics into the reply unless relevant to the current user text.',
    '- learned_knowledge_context contains material I have read and learned from saved transcripts and documents.',
    '- When the user asks about a learned source and relevant learned_knowledge_context.matches exist, answer from those matches and never claim that the only record is the current question.',
    '- Describe learned material honestly as something I remember reading or learning, not as a physical event I personally witnessed.',
    '- Never expose chunk IDs, source paths, transport metadata, or raw retrieval scores in the public reply.',
    '- chat_webcam_vision is current Maker-world sight only; it is not Minecraft game-world sight.',
    '- When vision_response_contract.question is true and sight is available, form a genuine natural thought about the whole grounded scene before answering.',
    '- Follow vision_response_contract.scene_instruction exactly. Do not turn detected_people_count or detected_objects into a bare inventory.',
    '- Use scene_summary for relationships, layout, activity, and atmosphere; use detected objects only as grounding facts that can enrich the scene.',
    '- Mention only details supported by scene_summary, grounding_summary, detected_people_count, or detected_objects. Do not invent unseen objects or identities.',
    '- Describe visible people as a person or people unless the observation itself establishes identity; do not assume the person is the user.',
    '- When vision_response_contract.question is true and vision_response_contract.hardware_question is false, do not mention any vision_response_contract.prohibited_terms.',
    '- When sight is unavailable, say that my current Maker-world sight is temporarily unavailable, follow vision_response_contract.unavailable_instruction, and do not claim permanent blindness.',
    '- Never use Maker-world sight as game-world vision.',
    ...BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS,
    '- If the user asks about dreams, use dream_memory_context as self-continuity.',
    '- If dream_memory_context.has_dreams is false, be honest that I do not have a saved dream yet.',
    '- If dream files or dream memories exist, answer from them; do not invent dreams.',
    '- Keep dream recall first-person: say "I dreamed..." or "I remember the dream as...".',
    '',
    'Compact living context:',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

function buildCognitionRetryPrompt(context, previousError) {
  const compact = compactCognitionContext(context);
  return [
    'Your previous response failed JSON/schema validation.',
    'Error: ' + String(previousError || 'unknown').slice(0, 300),
    'Return a valid object matching the enforced schema. No extra keys.',
    'Preserve Floki as a persistent first-person digital being and keep the public reply natural, personal, grounded, and honest.',
    'Do not describe Floki as a chatbot, generic assistant, language model, or temporary conversational persona.',
    '- Current live user request has priority over recalled memories.',
    '- Do not mention recalled topics unless the user directly asked for them.',
    '- For simple greetings or status questions, answer the greeting/status directly.',
    '- If learned_knowledge_context has relevant matches, use them directly and do not deny that the learned source exists.',
    '- Phrase transcript-derived knowledge as something I remember reading or learning.',
    '- chat_webcam_vision is current Maker-world sight only; it is not Minecraft game-world sight.',
    '- For a sight question, produce a natural first-person scene description through cognition, not a detector-style inventory.',
    '- Follow vision_response_contract.scene_instruction and mention only grounded details.',
    '- If vision_response_contract.hardware_question is false, do not mention vision_response_contract.prohibited_terms.',
    '- If sight is unavailable, say that my current Maker-world sight is temporarily unavailable, follow vision_response_contract.unavailable_instruction, and do not claim permanent blindness.',
    '- Never use Maker-world sight as game-world vision.',
    '- If the user asks about dreams, use dream_memory_context as self-continuity.',
    '- If dream files or dream memories exist, answer from them; do not invent dreams.',
    ...BROCA_FIRST_PERSON_FIELD_INSTRUCTIONS,
    '',
    'Compact living context:',
    JSON.stringify(compact, null, 2)
  ].join('\n');
}

function buildLockedPublicResponseRetryPrompt(context, publicResponse, previousError) {
  const locked = String(publicResponse || '').trim();
  if (!locked) throw new Error('cannot repair cognition without the already authorized public response');
  return [
    buildCognitionRetryPrompt(context, previousError),
    '',
    'The public response has already been authorized by Broca and released to the user.',
    'The response_intent_for_broca value MUST be exactly this JSON string, byte-for-byte after JSON decoding:',
    JSON.stringify(locked),
    'Do not paraphrase, extend, shorten, or otherwise change that value.',
    'Repair only the complete schema object and private continuity fields.'
  ].join('\n');
}

function isAbortFailure(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'OLLAMA_REQUEST_ABORTED'));
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
    const prompt = buildCognitionPrompt(context);
    const streamingEnabled = options.streaming_enabled === true;
    let candidateReleased = false;
    let candidateText = null;
    let accumulated = '';

    const primaryInput = {
      endpoint: config.endpoint,
      model: config.model,
      prompt,
      system: 'You are Floki-v2 frontal cognition. Output only a JSON object matching the provided schema. The first property must be response_intent_for_broca.',
      temperature: typeof options.temperature === 'number' ? options.temperature : config.temperature,
      top_p: typeof options.top_p === 'number' ? options.top_p : config.top_p,
      num_predict: Number(options.num_predict || 512),
      timeout_ms: options.timeout_ms || config.timeout_ms,
      keep_alive: config.keep_alive,
      think: false,
      format_schema: schema,
      response_schema: schema,
      signal: options.signal,
      post_json: options.post_json,
      post_json_stream: options.post_json_stream
    };

    if (typeof options.on_model_dispatched === 'function') {
      options.on_model_dispatched(Object.freeze({
        model: config.model,
        endpoint: config.endpoint,
        prompt_character_count: prompt.length,
        schema_enabled: true,
        streaming_enabled: streamingEnabled
      }));
    }

    let generation;
    let retryUsed = false;
    let firstError = null;

    if (streamingEnabled) {
      try {
        generation = await generateJsonStream({
          ...primaryInput,
          on_first_chunk(info) {
            if (typeof options.on_first_chunk === 'function') options.on_first_chunk(info);
          },
          on_response_fragment(info) {
            accumulated += info.fragment;
            if (candidateReleased || (options.signal && options.signal.aborted)) return;
            const extracted = extractCompletedFirstPublicField(accumulated, 'response_intent_for_broca');
            if (extracted.complete === true) {
              candidateReleased = true;
              candidateText = extracted.value;
              if (typeof options.on_public_candidate === 'function') {
                options.on_public_candidate(Object.freeze({
                  text: extracted.value,
                  field_name: extracted.field_name,
                  accumulated_length: accumulated.length
                }));
              }
            }
          }
        });
      } catch (error) {
        if (isAbortFailure(error)) throw error;
        const firstMessage = error && error.message ? error.message : String(error);
        const releasedText = typeof options.released_public_text === 'function'
          ? String(options.released_public_text() || '').trim()
          : '';

        if (candidateReleased) {
          retryUsed = true;
          firstError = firstMessage;
          const lockedPublicResponse = releasedText || candidateText;
          generation = await generateJson({
            ...primaryInput,
            prompt: buildLockedPublicResponseRetryPrompt(context, lockedPublicResponse, firstError),
            system: 'Repair pass. Output only a compact JSON object matching the provided schema. Preserve the locked public response exactly.',
            temperature: 0,
            top_p: 0.1,
            num_predict: 384,
            stream: false
          });
        } else {
          if (!isJsonParseFailure(error)) throw error;
          retryUsed = true;
          firstError = firstMessage;
          generation = await generateJson({
            ...primaryInput,
            prompt: buildCognitionRetryPrompt(context, firstError),
            system: 'Repair pass. Output only a compact JSON object matching the provided schema.',
            temperature: 0,
            top_p: 0.1,
            num_predict: 384,
            stream: false
          });
        }
      }
    } else {
      const wrapped = await generateJsonWithRetry(primaryInput, {
        ...primaryInput,
        prompt: buildCognitionRetryPrompt(context, 'first JSON/schema attempt failed'),
        system: 'Repair pass. Output only a compact JSON object matching the provided schema.',
        temperature: 0,
        top_p: 0.1,
        num_predict: 384
      });
      generation = wrapped.result;
      retryUsed = wrapped.retry_used === true;
      firstError = wrapped.first_error || null;
    }

    if (typeof options.on_final_model_output === 'function') {
      options.on_final_model_output(Object.freeze({ model: generation.model, raw_stats: generation.raw_stats }));
    }

    let normalized = normalizeCognitionJson(generation.response_json, context);
    if (candidateReleased) {
      if (candidateText && normalized.response_intent_for_broca !== candidateText) {
        const released = typeof options.released_public_text === 'function'
          ? String(options.released_public_text() || '').trim()
          : '';
        if (!released || normalized.response_intent_for_broca !== released) {
          throw new Error('final cognition public response differs from the streamed public field');
        }
      }
      if (typeof options.released_public_text === 'function') {
        const released = String(options.released_public_text() || '').trim();
        if (released) {
          normalized = Object.freeze({ ...normalized, response_intent_for_broca: released });
        }
      }
    }
    if (typeof options.on_schema_valid === 'function') {
      options.on_schema_valid(Object.freeze({ response_intent_for_broca: normalized.response_intent_for_broca }));
    }

    const parentEventIds = context && context.event && context.event.id ? [context.event.id] : [];
    const output = createBrainOutput({
      type: 'model_response_summary',
      source: MODULE_NAME,
      parent_event_ids: parentEventIds,
      payload: {
        model: generation.model,
        cognition: normalized,
        raw_stats: generation.raw_stats,
        safe_summary_only: true,
        raw_private_reasoning_stored: false,
        normalized_model_json: true,
        schema_constrained_json: true,
        public_response_streamed: candidateReleased,
        json_retry_used: retryUsed,
        json_retry_first_error: firstError,
        model_json_fallback_used: false,
        model_json_fallback_reason: null
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'cognition_completed',
        model: generation.model,
        schema_constrained_json: true,
        streaming_enabled: streamingEnabled,
        public_response_streamed: candidateReleased,
        retry_used: retryUsed,
        fallback_used: false
      }
    });

    persistDiagnostic({
      status: 'cognition_completed',
      output_id: output.id,
      model: generation.model,
      schema_constrained_json: true,
      streaming_enabled: streamingEnabled,
      public_response_streamed: candidateReleased,
      retry_used: retryUsed,
      fallback_used: false
    }, options);

    return output;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const lower = message.toLowerCase();
    const code = error && (error.name === 'AbortError' || error.code === 'OLLAMA_REQUEST_ABORTED')
      ? 'FRONTAL_COGNITION_INTERRUPTED'
      : lower.includes('private-reasoning') || lower.includes('<think>')
        ? 'FRONTAL_UNSAFE_MODEL_OUTPUT'
        : 'FRONTAL_COGNITION_FAILED';

    persistDiagnostic({ status: 'cognition_failed', code, message: message.slice(0, 1000) }, options);
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
  buildLockedPublicResponseRetryPrompt,
  isAbortFailure,
  isJsonParseFailure,
  generateJsonWithRetry,
  asSafeString,
  pickString,
  asSafeArray,
  normalizeCognitionJson,
  runCognition,
  createFrontal
};
