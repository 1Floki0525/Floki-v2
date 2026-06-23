'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getCognitionConfig } = require('../config/model-config.cjs');
const { buildRichDreamContext } = require('./rich-dream-context.cjs');
const {
  resolveDreamQualityConfig,
  validateDreamQuality,
  formatDreamStoryParagraphs,
  buildDreamQualityInstructions,
  buildQualityRegenerationPrompt,
  groundedSourceDescriptions
} = require('./dream-quality.cjs');
const {
  ensureDirSync,
  ensureParentDirSync,
  writeJsonFileAtomicSync,
  writeTextFileAtomicSync
} = require('../util/fs-safe.cjs');
const { appendJsonlSync } = require('../util/jsonl.cjs');
const {
  generateJson,
  rejectPrivateReasoningMarkers
} = require('../model/ollama-client.cjs');

const {
  PROJECT_ROOT: ROOT,
  getPathConfig,
  getDreamConfig,
  getSleepConfig
} = require('../config/floki-config.cjs');

const DREAM_ENGINE_OUTPUT_DIR = path.join(
  ROOT,
  '.floki-tools',
  'output',
  'dream-engine'
);

const RUNTIME_OWNED_DREAM_FIELDS = Object.freeze([
  'memory_sources',
  'knowledge_sources',
  'rem_cycle_number',
  'safe_summary_only',
  'remembered_as'
]);

const DREAM_ENGINE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'dream_story',
    'emotional_tone',
    'symbols',
    'consolidation_summary',
    'first_person_reflection'
  ],
  properties: {
    title: { type: 'string' },
    dream_story: { type: 'string' },
    emotional_tone: { type: 'string' },
    symbols: {
      type: 'array',
      items: { type: 'string' }
    },
    consolidation_summary: { type: 'string' },
    first_person_reflection: {
      type: 'string',
      description: 'Use natural first-person language. Never narrate Floki as a separate third-person subject.'
    }
  }
});

const BANNED_DREAM_MARKERS = Object.freeze([
  '<think>',
  '</think>',
  'chain_of_thought',
  'hidden_reasoning',
  'raw_reasoning',
  'scratchpad'
]);

const FIRST_PERSON_DREAM_FIELDS = Object.freeze(new Set([
  'dream_story'
]));

function getDreamRootFromYaml(mode) {
  return getPathConfig(mode || 'chat').dream_root;
}

function yamlDreamRoot() {
  return getDreamRootFromYaml('chat');
}

function yamlSleepWindowStart() {
  return getSleepConfig('chat').start_hhmm;
}

function yamlSleepWindowEnd() {
  return getSleepConfig('chat').end_hhmm;
}

const dreamRootFallback = yamlDreamRoot();
const sleepWindowStartFallback = yamlSleepWindowStart();
const sleepWindowEndFallback = yamlSleepWindowEnd();

function nowIso(options = {}) {
  if (typeof options.clock === 'function') {
    return new Date(options.clock()).toISOString();
  }

  if (options.now) {
    return new Date(options.now).toISOString();
  }

  return new Date().toISOString();
}

function dreamEngineAllowed(env = process.env) {
  return env.FLOKI_ALLOW_DREAM_ENGINE === '1';
}

function dreamEngineGuardStatus(env = process.env) {
  const allowed = dreamEngineAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_DREAM_ENGINE=1',
    dream_engine_run_now: false,
    model_called_now: false,
    dream_txt_written: false,
    dream_index_appended: false,
    persistent_memory_used: false,
    memory_write_now: false,
    chat_mode_only: true,
    game_mode_started: false,
    minecraft_called: false,
    reason: allowed
      ? 'Dream engine is explicitly allowed for this run.'
      : 'Dream engine is guarded and will not call the model or write dreams without FLOKI_ALLOW_DREAM_ENGINE=1.'
  });
}

function getDreamRoot(options = {}) {
  return path.resolve(
    options.dream_root ||
    process.env.FLOKI_DREAM_ROOT ||
    dreamRootFallback
  );
}

function safeArray(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function buildDreamContext(options = {}) {
  return buildRichDreamContext(options);
}

function buildDreamPrompt(context, options = {}) {
  return [
    'Generate one grounded, vivid REM dream for Floki.',
    'Return only one JSON object matching the model-content schema.',
    'Do not emit memory_sources, knowledge_sources, rem_cycle_number, safe_summary_only, remembered_as, timestamps, file paths, or provenance fields.',
    'Runtime owns all metadata and attaches trusted provenance after the narrative passes validation.',
    'No markdown. No private reasoning. No hidden chain-of-thought.',
    'The dream is a private remembered inner experience, not a public transcript turn.',
    'Write the dream_story in natural first-person voice. Never narrate Floki as a separate third-person subject.',
    'Write first_person_reflection as a personal reflection when possible. Runtime guarantees its final first-person grammar.',
    'Minecraft experience may appear only as remembered or symbolic material unless the context explicitly describes an event.',
    '',
    buildDreamQualityInstructions(context, options),
    '',
    'Runtime-selected grounding plan:',
    JSON.stringify(context.dream_grounding_plan || {}, null, 2),
    '',
    'Full dream context:',
    JSON.stringify(context, null, 2)
  ].join('\n');
}

function containsExplicitThirdPersonSelfNarration(text) {
  const value = String(text || '');

  return /\bFloki\s+(?:dreamed|dreams|remembers?|remembered|reflects?|reflected|feels?|felt|thinks?|thought|wants?|wanted|hopes?|hoped|fears?|feared|learns?|learned|realizes?|realized|understands?|understood|wakes?|woke|is|was|has|had)\b/i.test(value) ||
    /\bFloki['’]s\s+(?:dream|memory|memories|reflection|feeling|feelings|thought|thoughts|hope|hopes|fear|fears|identity|personality)\b/i.test(value) ||
    /^\s*Floki\b/i.test(value);
}

function hasFirstPersonVoice(text) {
  return /\b(?:I|me|my|mine|myself|we|us|our|ours|ourselves)\b/i.test(
    String(text || '')
  );
}

function assertDreamSelfVoice(text, fieldName) {
  if (!FIRST_PERSON_DREAM_FIELDS.has(fieldName)) {
    return true;
  }

  if (containsExplicitThirdPersonSelfNarration(text)) {
    throw new Error(
      fieldName + ' contains explicit third-person self narration'
    );
  }

  if (!hasFirstPersonVoice(text)) {
    throw new Error(fieldName + ' must use first-person voice');
  }

  return true;
}

function runtimeRememberedAs(modelDream) {
  const title = assertSafeDreamText(
    modelDream && modelDream.title,
    'title'
  ).replace(/[.!?]+$/g, '');

  const symbols = safeArray(
    modelDream && modelDream.symbols,
    2
  );

  const symbolClause = symbols.length > 0
    ? ', marked by ' + symbols.join(' and ')
    : '';

  const rememberedAs =
    'I remember this dream as "' +
    title +
    '"' +
    symbolClause +
    '.';

  assertDreamSelfVoice(rememberedAs, 'dream_story');
  return rememberedAs;
}

function runtimeFirstPersonReflection(value) {
  const text = assertSafeDreamText(
    value,
    'first_person_reflection_content'
  );

  if (containsExplicitThirdPersonSelfNarration(text)) {
    throw new Error(
      'first_person_reflection contains explicit third-person self narration'
    );
  }

  if (hasFirstPersonVoice(text)) {
    return text;
  }

  const normalized =
    'I reflect on this dream through this thought: ' +
    text;

  if (!hasFirstPersonVoice(normalized)) {
    throw new Error(
      'runtime failed to normalize first_person_reflection into first-person voice'
    );
  }

  return normalized;
}

function assertSafeDreamText(value, fieldName) {
  const text = String(value || '').trim();

  if (!text) {
    throw new Error(fieldName + ' must be a non-empty string');
  }

  rejectPrivateReasoningMarkers(text, fieldName);

  const lower = text.toLowerCase();
  for (const marker of BANNED_DREAM_MARKERS) {
    if (lower.includes(marker)) {
      throw new Error(
        fieldName + ' contains banned private reasoning marker: ' + marker
      );
    }
  }

  assertDreamSelfVoice(text, fieldName);
  return text;
}

function validateModelDreamJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('dream model JSON must be an object');
  }

  rejectPrivateReasoningMarkers(JSON.stringify(json), 'dream model JSON');

  for (const key of DREAM_ENGINE_SCHEMA.required) {
    if (!Object.prototype.hasOwnProperty.call(json, key)) {
      throw new Error('dream model JSON missing required field: ' + key);
    }
  }

  return Object.freeze({
    title: assertSafeDreamText(json.title, 'title').slice(0, 140),
    dream_story: assertSafeDreamText(json.dream_story, 'dream_story'),
    emotional_tone: assertSafeDreamText(
      json.emotional_tone,
      'emotional_tone'
    ).slice(0, 600),
    symbols: safeArray(json.symbols, 16).map((item) =>
      assertSafeDreamText(item, 'symbols item')
    ),
    consolidation_summary: assertSafeDreamText(
      json.consolidation_summary,
      'consolidation_summary'
    ),
    first_person_reflection: assertSafeDreamText(
      json.first_person_reflection,
      'first_person_reflection_content'
    )
  });
}

function groundingPlanFromContext(context = {}, options = {}) {
  const qualityConfig = resolveDreamQualityConfig(options);
  const plan = context.dream_grounding_plan &&
    typeof context.dream_grounding_plan === 'object'
    ? context.dream_grounding_plan
    : {};

  const memoryRecords = Array.isArray(plan.memory_records)
    ? plan.memory_records
    : Array.isArray(context.memory_source_records)
      ? context.memory_source_records
      : [];

  const knowledgeRecords = Array.isArray(plan.knowledge_records)
    ? plan.knowledge_records
    : Array.isArray(context.knowledge_source_records)
      ? context.knowledge_source_records
      : [];

  return Object.freeze({
    memory_records: memoryRecords.slice(
      0,
      qualityConfig.grounding_memory_limit
    ),
    knowledge_records: knowledgeRecords.slice(
      0,
      qualityConfig.grounding_knowledge_limit
    )
  });
}

function describeGroundingRecord(record) {
  const id = record && record.id ? String(record.id) : null;
  const category = record && record.category
    ? String(record.category)
    : null;
  const summary = String(
    record && (record.summary || record.text) || ''
  ).trim();

  return [
    id,
    category ? '[' + category + ']' : null,
    summary
  ].filter(Boolean).join(' ');
}

function composeRuntimeDream(modelDream, context = {}, options = {}) {
  const validatedModelDream = validateModelDreamJson(modelDream);
  const groundingPlan = groundingPlanFromContext(context, options);
  const remCycleNumber = Number(
    options.rem_cycle_number ||
    context.rem_cycle_number ||
    1
  );

  if (!Number.isInteger(remCycleNumber) || remCycleNumber < 1) {
    throw new Error('runtime rem_cycle_number must be a positive integer');
  }

  return Object.freeze({
    ...validatedModelDream,
    remembered_as: runtimeRememberedAs(validatedModelDream),
    first_person_reflection: runtimeFirstPersonReflection(
      validatedModelDream.first_person_reflection
    ),
    memory_sources: groundingPlan.memory_records
      .map(describeGroundingRecord)
      .filter(Boolean),
    knowledge_sources: groundingPlan.knowledge_records
      .map(describeGroundingRecord)
      .filter(Boolean),
    rem_cycle_number: remCycleNumber,
    safe_summary_only: true,
    runtime_metadata_authority: true,
    model_generated_runtime_metadata_accepted: false
  });
}

function validateDreamJson(json, options = {}) {
  const context = options.context || {
    rem_cycle_number: options.rem_cycle_number || json.rem_cycle_number || 1,
    dream_grounding_plan: {
      memory_records: safeArray(
        options.runtime_memory_sources || json.memory_sources,
        16
      ).map((summary, index) => ({
        id: 'M' + String(index + 1),
        category: 'compatibility',
        summary
      })),
      knowledge_records: safeArray(
        options.runtime_knowledge_sources || json.knowledge_sources,
        16
      ).map((summary, index) => ({
        id: 'K' + String(index + 1),
        category: 'compatibility',
        summary
      }))
    },
    recent_dreams_to_avoid: []
  };

  const dream = composeRuntimeDream(json, context, options);

  if (options.enforce_quality === true) {
    validateDreamQuality(dream, context, options);
  }

  return dream;
}

function renderDreamText(dreamJson, context, options = {}) {
  const qualityConfig = resolveDreamQualityConfig(options);
  const dream = validateDreamJson(dreamJson, {
    ...options,
    context,
    quality_config: qualityConfig,
    enforce_quality: true
  });
  const quality = validateDreamQuality(dream, context, {
    ...options,
    quality_config: qualityConfig
  });
  const createdAt = options.created_at ||
    context.created_at ||
    nowIso(options);

  const personalityThemes = []
    .concat(context.personality && context.personality.values || [])
    .concat(context.personality && context.personality.hopes || [])
    .concat(context.beliefs_biases || [])
    .slice(0, 12);

  return [
    'Title: ' + dream.title,
    'Date/time: ' + createdAt,
    'REM cycle number: ' + dream.rem_cycle_number,
    'Sleep window: ' +
      context.sleep_window_start +
      ' to ' +
      context.sleep_window_end +
      ' (' + context.timezone + ')',
    'Story length: ' +
      quality.story_word_count +
      ' words, ' +
      quality.story_sentence_count +
      ' sentences',
    '',
    'Grounding supplied to dream generation:',
    '- memories, beliefs, relationships, hopes, and fears: ' +
      (dream.memory_sources.length
        ? groundedSourceDescriptions(dream.memory_sources).join('; ')
        : 'no persisted memory grounding was available'),
    '- emotions: ' +
      JSON.stringify(
        context.emotions && context.emotions.current || {}
      ),
    '- personality and belief themes: ' +
      (personalityThemes.length
        ? personalityThemes.join('; ')
        : 'no persisted personality themes were available'),
    '- conversations: ' +
      (context.conversations && context.conversations.length
        ? context.conversations.join('; ')
        : 'no recent conversation summary was available'),
    '- read/watched/listened knowledge: ' +
      (dream.knowledge_sources.length
        ? groundedSourceDescriptions(dream.knowledge_sources).join('; ')
        : 'no learned knowledge grounding was available'),
    '- unresolved concerns and hopes: ' +
      (context.unresolved_concerns_hopes &&
       context.unresolved_concerns_hopes.length
        ? context.unresolved_concerns_hopes.join('; ')
        : 'no unresolved theme was recorded'),
    '',
    'Dream story:',
    formatDreamStoryParagraphs(dream.dream_story),
    '',
    'Emotional tone:',
    dream.emotional_tone,
    '',
    'Memory consolidation notes:',
    dream.consolidation_summary,
    '',
    'What I may remember from this dream:',
    dream.remembered_as,
    '',
    'First-person reflection:',
    dream.first_person_reflection,
    '',
    'Symbols:',
    dream.symbols.map((symbol) => '- ' + symbol).join('\n'),
    ''
  ].join('\n');
}

function safeTitle(title) {
  const safe = String(title || 'untitled-dream')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return safe || 'untitled-dream';
}

function fileTimestamp(iso) {
  return new Date(iso)
    .toISOString()
    .replace(/[-:.]/g, '')
    .replace('T', 't')
    .replace('Z', 'z');
}

function dreamDayDir(root, iso) {
  const date = new Date(iso);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');

  return path.join(root, yyyy, mm, dd);
}

function writeDreamTxt(dreamText, metadata, options = {}) {
  const root = getDreamRoot(options);
  const createdAt = metadata.created_at || nowIso(options);
  const cycle = String(metadata.rem_cycle_number || 1).padStart(2, '0');
  const title = safeTitle(metadata.title || 'dream');
  const stem =
    'rem-cycle-' +
    cycle +
    '_' +
    fileTimestamp(createdAt) +
    '_' +
    title;
  const dir = dreamDayDir(root, createdAt);
  const txtFile = path.join(dir, stem + '.txt');
  const metadataFile = path.join(dir, stem + '.json');

  const metadataRecord = Object.freeze({
    ...metadata,
    dream_txt_file: txtFile,
    dream_metadata_file: metadataFile,
    dream_root: root,
    chat_mode_only: true,
    game_mode_started: false
  });

  ensureDirSync(dir);
  writeTextFileAtomicSync(txtFile, dreamText);
  writeJsonFileAtomicSync(metadataFile, metadataRecord);

  return Object.freeze({
    dream_txt_file: txtFile,
    dream_metadata_file: metadataFile,
    metadata: metadataRecord
  });
}

function appendDreamIndex(record, options = {}) {
  const root = getDreamRoot(options);
  const indexFile =
    options.index_file ||
    path.join(root, 'dream-index.jsonl');

  ensureParentDirSync(indexFile);
  appendJsonlSync(indexFile, {
    ...record,
    dream_root: root,
    chat_mode_only: true,
    game_mode_started: false
  });

  return indexFile;
}

function isJsonRepairableFailure(error) {
  const message = error && error.message
    ? error.message
    : String(error);
  const lower = message.toLowerCase();

  return lower.includes('parseable json') ||
    lower.includes('invalid json') ||
    lower.includes('json schema validation failed') ||
    lower.includes('expected property name') ||
    lower.includes('unterminated string') ||
    lower.includes('missing required');
}

async function callDreamGenerator(prompt, context, options = {}) {
  if (typeof options.dream_generator === 'function') {
    const generated = await options.dream_generator({
      prompt,
      context,
      schema: DREAM_ENGINE_SCHEMA
    });

    return Object.freeze({
      model_called_now: options.fake_generator_counts_as_model === true,
      model: generated && generated.model
        ? generated.model
        : 'injected-contract-generator',
      response_json: generated && generated.response_json
        ? generated.response_json
        : generated,
      raw_stats: {
        schema_constrained_json: true,
        injected_generator: true
      }
    });
  }

  const config = options.model_config || getCognitionConfig();
  const dreamConfig = getDreamConfig(options.mode || 'chat');

  const request = {
    endpoint: config.endpoint,
    model: config.model,
    prompt,
    system: [
      'You are Floki-v2 private REM dream generation.',
      'Create a full-length, vivid, grounded first-person dream narrative.',
      'Use the supplied memory, personality, belief, emotional, relationship, and learned-knowledge context.',
      'Generate narrative content only.',
      'Never emit runtime metadata, remembered_as, or source IDs.',
      'Output only schema-constrained JSON.',
      'Never reveal private reasoning.'
    ].join(' '),
    temperature: typeof options.temperature === 'number'
      ? options.temperature
      : dreamConfig.temperature,
    top_p: typeof options.top_p === 'number'
      ? options.top_p
      : dreamConfig.top_p,
    num_predict: Number(
      options.num_predict ||
      dreamConfig.num_predict
    ),
    timeout_ms: options.timeout_ms || config.timeout_ms,
    keep_alive: config.keep_alive,
    think: false,
    format_schema: DREAM_ENGINE_SCHEMA,
    response_schema: DREAM_ENGINE_SCHEMA
  };

  let result;
  let retryUsed = false;
  let firstError = null;

  try {
    result = await generateJson(request);
  } catch (error) {
    if (!isJsonRepairableFailure(error)) {
      throw error;
    }

    firstError = error && error.message
      ? error.message
      : String(error);
    retryUsed = true;

    result = await generateJson({
      ...request,
      prompt: [
        'The previous response could not be parsed as the model-content JSON schema.',
        'Serialization error: ' + firstError.slice(0, 500),
        'Regenerate the complete dream once.',
        'Do not shorten the narrative.',
        'Return exactly one JSON object with only these fields:',
        DREAM_ENGINE_SCHEMA.required.join(', '),
        'Do not emit runtime metadata, remembered_as, or source IDs.',
        'No markdown, comments, extra keys, or private reasoning.',
        '',
        buildDreamQualityInstructions(context, options),
        '',
        'Grounding context:',
        JSON.stringify(context, null, 2)
      ].join('\n'),
      system: 'Strict JSON repair for a full-length grounded REM dream. Output model narrative fields only.',
      temperature: dreamConfig.retry_temperature,
      top_p: dreamConfig.retry_top_p,
      num_predict: Number(
        options.retry_num_predict ||
        dreamConfig.retry_num_predict
      )
    });
  }

  return Object.freeze({
    model_called_now: true,
    model: result.model,
    response_json: result.response_json,
    raw_stats: {
      ...result.raw_stats,
      json_retry_used: retryUsed,
      json_retry_first_error: firstError
    }
  });
}

async function generateValidatedDream(prompt, context, options = {}) {
  const qualityConfig = resolveDreamQualityConfig(options);
  const maxRegenerations = Math.max(
    0,
    Math.min(
      1,
      Number(qualityConfig.quality_regeneration_attempts)
    )
  );

  let currentPrompt = prompt;
  let lastError = null;

  for (
    let attempt = 0;
    attempt <= maxRegenerations;
    attempt += 1
  ) {
    const generation = await callDreamGenerator(
      currentPrompt,
      context,
      options
    );

    try {
      const modelDream = validateModelDreamJson(
        generation.response_json
      );
      const dreamJson = composeRuntimeDream(
        modelDream,
        context,
        options
      );
      const qualityMetrics = validateDreamQuality(
        dreamJson,
        context,
        {
          ...options,
          quality_config: qualityConfig
        }
      );

      return Object.freeze({
        generation: Object.freeze({
          ...generation,
          raw_stats: {
            ...generation.raw_stats,
            quality_regeneration_used: attempt > 0,
            quality_regeneration_attempts: attempt,
            quality_first_error: lastError
          }
        }),
        model_dream_json: modelDream,
        dream_json: dreamJson,
        quality_metrics: qualityMetrics,
        validation_retry_used: attempt > 0,
        validation_retry_first_error: lastError
      });
    } catch (error) {
      if (typeof options.dream_generator === 'function') {
        throw error;
      }

      lastError = error && error.message
        ? error.message
        : String(error);

      if (attempt >= maxRegenerations) {
        throw new Error(
          'DREAM_QUALITY_CONTRACT_REJECTED_AFTER_' +
          String(maxRegenerations + 1) +
          '_ATTEMPTS: ' +
          lastError
        );
      }

      currentPrompt = buildQualityRegenerationPrompt(
        error,
        generation.response_json,
        context,
        {
          ...options,
          quality_config: qualityConfig
        }
      );
    }
  }

  throw new Error(
    'DREAM_QUALITY_GENERATION_UNREACHABLE: ' +
    String(lastError || 'unknown')
  );
}

function writeDreamEngineReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const reportFile =
    options.report_file ||
    path.join(
      DREAM_ENGINE_OUTPUT_DIR,
      'latest-dream-engine.json'
    );

  ensureParentDirSync(reportFile);
  fs.writeFileSync(
    reportFile,
    JSON.stringify(status, null, 2) + '\n'
  );

  return reportFile;
}

async function runDreamEngineOnce(options = {}) {
  const env = options.env || process.env;
  const guard = dreamEngineGuardStatus(env);

  if (!guard.allowed_now) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_DREAM_ENGINE_BLOCKED',
      guard,
      dream_engine_run_now: false,
      model_called_now: false,
      schema_constrained_json: false,
      model_json_fallback_used: false,
      dream_txt_written: false,
      dream_txt_file: null,
      dream_metadata_file: null,
      dream_index_appended: false,
      dream_root: getDreamRoot(options),
      rem_cycle_number: Number(options.rem_cycle_number || 1),
      sleep_window_start:
        options.sleep_window_start ||
        sleepWindowStartFallback,
      sleep_window_end:
        options.sleep_window_end ||
        sleepWindowEndFallback,
      cold_storage_dream_path_used:
        getDreamRoot(options) ===
        path.resolve(dreamRootFallback),
      persistent_memory_used: false,
      emotional_reinforcement_used: false,
      knowledge_context_used: false,
      first_person_voice_verified: false,
      third_person_self_reference_blocked: true,
      runtime_metadata_authority_verified: false,
      chat_mode_only: true,
      game_mode_started: false
    });

    return Object.freeze({
      ...status,
      report_file: writeDreamEngineReport(status, options)
    });
  }

  const context = options.context || buildDreamContext(options);
  const prompt = buildDreamPrompt(context, options);
  const validated = await generateValidatedDream(
    prompt,
    context,
    options
  );
  const generation = validated.generation;
  const dreamJson = validated.dream_json;
  const dreamText = renderDreamText(
    validated.model_dream_json,
    context,
    options
  );
  const createdAt = context.created_at || nowIso(options);

  const metadata = Object.freeze({
    title: dreamJson.title,
    created_at: createdAt,
    rem_cycle_number: dreamJson.rem_cycle_number,
    sleep_window_start: context.sleep_window_start,
    sleep_window_end: context.sleep_window_end,
    timezone: context.timezone,
    sleep_kind: options.sleep_kind || 'nightly_sleep',
    model: generation.model,
    schema_constrained_json:
      generation.raw_stats &&
      generation.raw_stats.schema_constrained_json === true,
    model_json_fallback_used: false,
    safe_summary_only: true,
    memory_sources: dreamJson.memory_sources,
    knowledge_sources: dreamJson.knowledge_sources,
    symbols: dreamJson.symbols,
    emotional_tone: dreamJson.emotional_tone,
    consolidation_summary: dreamJson.consolidation_summary,
    remembered_as: dreamJson.remembered_as,
    first_person_reflection:
      dreamJson.first_person_reflection,
    model_dream_json: validated.model_dream_json,
    dream_json: dreamJson,
    quality_metrics: validated.quality_metrics,
    grounding_plan: context.dream_grounding_plan || {},
    grounding_counts: context.grounding_counts || {},
    personality_used: context.personality_used === true,
    beliefs_biases_used:
      context.beliefs_biases_used === true,
    runtime_metadata_authority: true,
    model_generated_runtime_metadata_accepted: false
  });

  const written = writeDreamTxt(
    dreamText,
    metadata,
    options
  );

  const indexRecord = Object.freeze({
    title: dreamJson.title,
    created_at: createdAt,
    rem_cycle_number: dreamJson.rem_cycle_number,
    sleep_kind: options.sleep_kind || 'nightly_sleep',
    dream_txt_file: written.dream_txt_file,
    dream_metadata_file: written.dream_metadata_file,
    remembered_as: dreamJson.remembered_as,
    emotional_tone: dreamJson.emotional_tone,
    symbols: dreamJson.symbols
  });

  const indexFile = appendDreamIndex(
    indexRecord,
    options
  );

  const firstPersonVoiceVerified =
    hasFirstPersonVoice(dreamJson.dream_story) &&
    hasFirstPersonVoice(dreamJson.remembered_as) &&
    hasFirstPersonVoice(
      dreamJson.first_person_reflection
    );

  const status = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
    dream_engine_run_now: true,
    model_called_now:
      generation.model_called_now === true,
    schema_constrained_json:
      generation.raw_stats &&
      generation.raw_stats.schema_constrained_json === true,
    model_json_fallback_used: false,
    dream_txt_written: true,
    dream_txt_file: written.dream_txt_file,
    dream_metadata_file: written.dream_metadata_file,
    dream_index_file: indexFile,
    dream_index_appended: true,
    dream_root: getDreamRoot(options),
    rem_cycle_number: dreamJson.rem_cycle_number,
    sleep_window_start: context.sleep_window_start,
    sleep_window_end: context.sleep_window_end,
    cold_storage_dream_path_used:
      getDreamRoot(options) ===
      path.resolve(dreamRootFallback),
    persistent_memory_used:
      context.persistent_memory_used === true,
    emotional_reinforcement_used:
      context.emotional_reinforcement_used === true,
    knowledge_context_used:
      context.knowledge_context_used === true,
    first_person_voice_verified:
      firstPersonVoiceVerified,
    third_person_self_reference_blocked: true,
    rich_dream_quality_verified: true,
    story_word_count:
      validated.quality_metrics.story_word_count,
    story_paragraph_count:
      validated.quality_metrics.story_paragraph_count,
    story_sentence_count:
      validated.quality_metrics.story_sentence_count,
    grounded_memory_source_count:
      validated.quality_metrics.memory_source_count,
    grounded_knowledge_source_count:
      validated.quality_metrics.knowledge_source_count,
    personality_used:
      context.personality_used === true,
    beliefs_biases_used:
      context.beliefs_biases_used === true,
    runtime_metadata_authority_verified: true,
    model_generated_source_ids_accepted: false,
    quality_regeneration_attempts:
      generation.raw_stats.quality_regeneration_attempts || 0,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: writeDreamEngineReport(
      status,
      options
    )
  });
}

async function printDreamEngineProof() {
  const status = await runDreamEngineOnce();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printDreamEngineProof().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_DREAM_ENGINE_FAIL',
      error: error.message,
      dream_engine_run_now: true,
      model_called_now: true,
      model_json_fallback_used: false,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));

    process.exit(1);
  });
}

module.exports = {
  ROOT,
  DREAM_ENGINE_OUTPUT_DIR,
  RUNTIME_OWNED_DREAM_FIELDS,
  DREAM_ENGINE_SCHEMA,
  dreamRootFallback,
  dreamEngineAllowed,
  dreamEngineGuardStatus,
  getDreamRoot,
  buildDreamContext,
  buildDreamPrompt,
  validateModelDreamJson,
  groundingPlanFromContext,
  composeRuntimeDream,
  validateDreamJson,
  containsExplicitThirdPersonSelfNarration,
  hasFirstPersonVoice,
  assertDreamSelfVoice,
  runtimeRememberedAs,
  runtimeFirstPersonReflection,
  renderDreamText,
  writeDreamTxt,
  appendDreamIndex,
  runDreamEngineOnce,
  printDreamEngineProof
};
