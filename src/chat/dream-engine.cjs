'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getCognitionConfig } = require('../config/model-config.cjs');
const { createChatMemorySubstrate } = require('./chat-memory-substrate.cjs');
const { retrieveKnowledgeContext } = require('./knowledge-context.cjs');
const {
  ensureDirSync,
  ensureParentDirSync,
  writeJsonFileAtomicSync,
  writeTextFileAtomicSync,
  existsSync
} = require('../util/fs-safe.cjs');
const { appendJsonlSync, readJsonlSync } = require('../util/jsonl.cjs');
const { generateJson, rejectPrivateReasoningMarkers } = require('../model/ollama-client.cjs');
const { isThirdPersonSelfReference } = require('../../brain/broca/index.cjs');

const { PROJECT_ROOT: ROOT, getPathConfig, getDreamConfig, getSleepConfig } = require('../config/floki-config.cjs');
const DREAM_ENGINE_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'dream-engine');

function getDreamRootFromYaml(mode) {
  return getPathConfig(mode || 'chat').dream_root;
}

function yamlDreamRoot() {
  return getDreamRootFromYaml('chat');
}

function yamlSleepWindowStart() {
  const { getSleepConfig } = require('../config/floki-config.cjs');
  return getSleepConfig('chat').start_hhmm;
}

function yamlSleepWindowEnd() {
  const { getSleepConfig } = require('../config/floki-config.cjs');
  return getSleepConfig('chat').end_hhmm;
}

const dreamRootFallback = yamlDreamRoot();
const sleepWindowStartFallback = yamlSleepWindowStart();
const sleepWindowEndFallback = yamlSleepWindowEnd();
const DREAM_ENGINE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'dream_story',
    'emotional_tone',
    'memory_sources',
    'knowledge_sources',
    'symbols',
    'consolidation_summary',
    'remembered_as',
    'first_person_reflection',
    'rem_cycle_number',
    'safe_summary_only'
  ],
  properties: {
    title: { type: 'string' },
    dream_story: { type: 'string' },
    emotional_tone: { type: 'string' },
    memory_sources: { type: 'array', items: { type: 'string' } },
    knowledge_sources: { type: 'array', items: { type: 'string' } },
    symbols: { type: 'array', items: { type: 'string' } },
    consolidation_summary: { type: 'string' },
    remembered_as: { type: 'string' },
    first_person_reflection: { type: 'string' },
    rem_cycle_number: { type: 'integer' },
    safe_summary_only: { type: 'boolean' }
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

function nowIso(options = {}) {
  const clock = options.clock;
  if (typeof clock === 'function') {
    return new Date(clock()).toISOString();
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
  return path.resolve(options.dream_root || process.env.FLOKI_DREAM_ROOT || dreamRootFallback);
}

function safeArray(value, limit = 8) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function limitedArray(value, limit = 8) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function compactMemoryMatch(match) {
  const memory = match && match.memory ? match.memory : match;
  return Object.freeze({
    id: memory && memory.id ? memory.id : null,
    stream: memory && memory.stream ? memory.stream : null,
    category: memory && memory.category ? memory.category : null,
    summary: String(memory && (memory.summary || memory.text) || '').slice(0, 500),
    tags: safeArray(memory && memory.tags ? memory.tags : [], 10),
    emotion: memory && memory.emotion ? memory.emotion : {},
    score: Number(match && match.score || 0)
  });
}

function loadLatestJsonl(filePath, limit = 6) {
  if (!existsSync(filePath)) {
    return [];
  }
  return readJsonlSync(filePath).slice(-limit);
}

function buildDreamContext(options = {}) {
  const createdAt = nowIso(options);
  const remCycleNumber = Number(options.rem_cycle_number || 1);
  const sleepWindowStart = options.sleep_window_start || sleepWindowStartFallback;
  const sleepWindowEnd = options.sleep_window_end || sleepWindowEndFallback;
  const daySummary = String(options.day_summary || 'No separate day summary was supplied. Use available chat memories and affect state.').trim();
  const substrate = options.memory_substrate || createChatMemorySubstrate({
    base_dir: options.memory_base_dir
  });

  substrate.ensureReady();

  const query = [
    'today conversation memory emotion trust hope curiosity knowledge dream sleep unresolved concern',
    options.query || ''
  ].join(' ').trim();
  const recall = options.recall_context || substrate.recallContext({
    text: query,
    limit: Number(options.recall_limit || 4)
  });
  const emotionState = options.emotional_state || substrate.loadEmotionState();
  const memorySources = safeArray(options.memory_sources, 12).concat(
    limitedArray(recall.short_term_matches || [], 8).map((match) => compactMemoryMatch(match).summary),
    limitedArray(recall.long_term_matches || [], 8).map((match) => compactMemoryMatch(match).summary)
  ).filter(Boolean).slice(0, 16);
  const retrievedKnowledge = retrieveKnowledgeContext(query, options);
  const knowledgeSources = safeArray(options.knowledge_sources, 12).concat(
    retrievedKnowledge.knowledge_matches.map((match) => [match.title, match.channel_folder, match.summary].filter(Boolean).join(' — '))
  ).filter(Boolean).slice(0, 16);

  return Object.freeze({
    created_at: createdAt,
    rem_cycle_number: remCycleNumber,
    sleep_window_start: sleepWindowStart,
    sleep_window_end: sleepWindowEnd,
    timezone: options.timezone || process.env.FLOKI_SLEEP_TIMEZONE || 'America/Toronto',
    day_summary: daySummary,
    day_memories: limitedArray(recall.short_term_matches || [], 8).map(compactMemoryMatch),
    long_term_memories: limitedArray(recall.long_term_matches || [], 8).map(compactMemoryMatch),
    emotions: emotionState,
    conversations: safeArray(options.conversations, 8),
    thoughts: safeArray(options.thoughts, 8),
    knowledge_sources: knowledgeSources,
    unresolved_concerns_hopes: safeArray(options.unresolved_concerns_hopes, 8),
    memory_sources: memorySources,
    persistent_memory_used: true,
    emotional_reinforcement_used: true,
    knowledge_context_used: knowledgeSources.length > 0,
    knowledge_chunk_count_total: retrievedKnowledge.knowledge_chunk_count_total,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function buildDreamPrompt(context, options = {}) {
  return [
    'Generate one vivid chat-mode dream for Floki during a REM cycle.',
    'Return only JSON matching the enforced schema.',
    'No markdown. No private reasoning. No hidden chain-of-thought.',
    'The dream is a remembered inner experience in chat-mode memory, not physical sleep in a game world.',
    'Write the dream story as a surreal but coherent first-person dreamscape.',
    'Use "I dreamed..." or direct first-person reflection for remembered_as.',
    'Do not write "Floki dreamed..." or narrate Floki in third person.',
    'Do not claim active Minecraft/game/body/world interaction unless it is clearly symbolic source material from memory.',
    'Set safe_summary_only to true.',
    'Use rem_cycle_number: ' + Number(context.rem_cycle_number || options.rem_cycle_number || 1) + '.',
    '',
    'Dream context:',
    JSON.stringify(context, null, 2)
  ].join('\n');
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
      throw new Error(fieldName + ' contains banned private reasoning marker: ' + marker);
    }
  }
  if (isThirdPersonSelfReference(text) || /\bFloki\s+dreamed\b/i.test(text)) {
    throw new Error(fieldName + ' contains third-person self narration');
  }
  return text;
}

function validateDreamJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('dream JSON must be an object');
  }
  rejectPrivateReasoningMarkers(JSON.stringify(json), 'dream JSON');

  const required = DREAM_ENGINE_SCHEMA.required;
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(json, key)) {
      throw new Error('dream JSON missing required field: ' + key);
    }
  }

  const normalized = {
    title: assertSafeDreamText(json.title, 'title').slice(0, 140),
    dream_story: assertSafeDreamText(json.dream_story, 'dream_story'),
    emotional_tone: assertSafeDreamText(json.emotional_tone, 'emotional_tone').slice(0, 300),
    memory_sources: safeArray(json.memory_sources, 16).map((item) => assertSafeDreamText(item, 'memory_sources item')),
    knowledge_sources: safeArray(json.knowledge_sources, 16).map((item) => assertSafeDreamText(item, 'knowledge_sources item')),
    symbols: safeArray(json.symbols, 16).map((item) => assertSafeDreamText(item, 'symbols item')),
    consolidation_summary: assertSafeDreamText(json.consolidation_summary, 'consolidation_summary'),
    remembered_as: assertSafeDreamText(json.remembered_as, 'remembered_as'),
    first_person_reflection: assertSafeDreamText(json.first_person_reflection, 'first_person_reflection'),
    rem_cycle_number: Number(json.rem_cycle_number),
    safe_summary_only: json.safe_summary_only === true
  };

  if (!Number.isInteger(normalized.rem_cycle_number) || normalized.rem_cycle_number < 1) {
    throw new Error('rem_cycle_number must be a positive integer');
  }
  if (normalized.safe_summary_only !== true) {
    throw new Error('safe_summary_only must be true');
  }
  if (!/\bI\b|\bme\b|\bmy\b|\bmine\b|\bwe\b|\bour\b/i.test(normalized.dream_story + ' ' + normalized.remembered_as + ' ' + normalized.first_person_reflection)) {
    throw new Error('dream must include first-person voice');
  }

  return Object.freeze(normalized);
}

function renderDreamText(dreamJson, context, options = {}) {
  const dream = validateDreamJson(dreamJson);
  const createdAt = options.created_at || context.created_at || nowIso(options);
  const sources = [
    'day memories: ' + (dream.memory_sources.length > 0 ? dream.memory_sources.join('; ') : 'none supplied'),
    'emotions: ' + JSON.stringify((context.emotions && context.emotions.current) || {}),
    'conversations: ' + (context.conversations.length > 0 ? context.conversations.join('; ') : 'memory recall only'),
    'read/watched/listened knowledge: ' + (dream.knowledge_sources.length > 0 ? dream.knowledge_sources.join('; ') : 'none supplied'),
    'unresolved concerns/hopes: ' + (context.unresolved_concerns_hopes.length > 0 ? context.unresolved_concerns_hopes.join('; ') : 'none supplied')
  ];

  return [
    'Title: ' + dream.title,
    'Date/time: ' + createdAt,
    'REM cycle number: ' + dream.rem_cycle_number,
    'Sleep window: ' + context.sleep_window_start + ' to ' + context.sleep_window_end + ' (' + context.timezone + ')',
    '',
    'Sources used:',
    sources.map((source) => '- ' + source).join('\n'),
    '',
    'Dream story:',
    dream.dream_story,
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
    dream.symbols.length > 0 ? dream.symbols.map((symbol) => '- ' + symbol).join('\n') : '- none supplied',
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
  return new Date(iso).toISOString().replace(/[-:.]/g, '').replace('T', 't').replace('Z', 'z');
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
  const stem = 'rem-cycle-' + cycle + '_' + fileTimestamp(createdAt) + '_' + title;
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
  const indexFile = options.index_file || path.join(root, 'dream-index.jsonl');
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
  const message = error && error.message ? error.message : String(error);
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
      model: generated && generated.model ? generated.model : 'injected-contract-generator',
      response_json: generated && generated.response_json ? generated.response_json : generated,
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
    system: 'You are Floki-v2 dream generation in chat mode. Output only schema-constrained JSON.',
    temperature: typeof options.temperature === 'number' ? options.temperature : dreamConfig.temperature,
    top_p: typeof options.top_p === 'number' ? options.top_p : dreamConfig.top_p,
    num_predict: Number(options.num_predict || dreamConfig.num_predict),
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
    firstError = error && error.message ? error.message : String(error);
    retryUsed = true;
    const retryDreamConfig = getDreamConfig(options.mode || 'chat');
    const retryRequest = Object.freeze({
      ...request,
      prompt: [
        'Your previous dream response failed JSON/schema validation.',
        'Error: ' + firstError.slice(0, 300),
        'Return only one compact valid JSON object matching the schema.',
        'No markdown, no comments, no private reasoning, no extra keys.',
        'Use first-person dream memory. Do not write "Floki dreamed".',
        '',
        'Dream context:',
        JSON.stringify(context, null, 2)
      ].join('\n'),
      system: 'Repair pass. Output only compact schema-constrained JSON.',
      temperature: retryDreamConfig.retry_temperature,
      top_p: retryDreamConfig.retry_top_p,
      num_predict: Number(options.retry_num_predict || retryDreamConfig.retry_num_predict)
    });
    try {
      result = await generateJson(retryRequest);
    } catch (retryError) {
      const secondError = retryError && retryError.message ? retryError.message : String(retryError);
      result = await generateJson({
        ...retryRequest,
        prompt: [
          'Final repair pass. Return exactly one JSON object and nothing else.',
          'All string values must be short: 160 characters or fewer.',
          'Use empty arrays if unsure. Use safe_summary_only true.',
          'No markdown. No private reasoning. No extra keys.',
          'Required keys: title, dream_story, emotional_tone, memory_sources, knowledge_sources, symbols, consolidation_summary, remembered_as, first_person_reflection, rem_cycle_number, safe_summary_only.',
          'Use rem_cycle_number ' + Number(context.rem_cycle_number || options.rem_cycle_number || 1) + '.',
          'The self voice must be first person: I, me, my.',
          'Previous errors: ' + firstError.slice(0, 160) + ' | ' + secondError.slice(0, 160),
          'Context summary: REM cycle ' + Number(context.rem_cycle_number || 1) + ', sleep window ' + context.sleep_window_start + ' to ' + context.sleep_window_end + '.'
        ].join('\n'),
        num_predict: Number(options.final_retry_num_predict || 900)
      });
      retryUsed = true;
      firstError = firstError + ' | second retry error: ' + secondError;
    }
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
  const generation = await callDreamGenerator(prompt, context, options);

  try {
    return Object.freeze({
      generation,
      dream_json: validateDreamJson(generation.response_json),
      validation_retry_used: false,
      validation_retry_first_error: null
    });
  } catch (error) {
    if (typeof options.dream_generator === 'function') {
      throw error;
    }

    const firstError = error && error.message ? error.message : String(error);
    const retryPrompt = [
      'Your previous dream JSON was valid JSON but failed safety validation.',
      'Error: ' + firstError.slice(0, 300),
      'Rewrite the dream as one valid schema object.',
      'Keep it vivid, but every self-reference must be first person.',
      'Use "I dreamed..." and "I may remember..."',
      'Do not write "Floki dreamed" or "Floki remembers".',
      'No private reasoning, no markdown, no extra keys.',
      '',
      'Previous JSON:',
      JSON.stringify(generation.response_json, null, 2),
      '',
      'Dream context:',
      JSON.stringify(context, null, 2)
    ].join('\n');
    const validationRetryConfig = getDreamConfig(options.mode || 'chat');
    const repaired = await callDreamGenerator(retryPrompt, context, {
      ...options,
      temperature: validationRetryConfig.retry_temperature,
      top_p: validationRetryConfig.retry_top_p,
      num_predict: Number(options.validation_retry_num_predict || validationRetryConfig.retry_num_predict)
    });

    return Object.freeze({
      generation: Object.freeze({
        ...repaired,
        raw_stats: {
          ...repaired.raw_stats,
          validation_retry_used: true,
          validation_retry_first_error: firstError
        }
      }),
      dream_json: validateDreamJson(repaired.response_json),
      validation_retry_used: true,
      validation_retry_first_error: firstError
    });
  }
}

function writeDreamEngineReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }
  const reportFile = options.report_file || path.join(DREAM_ENGINE_OUTPUT_DIR, 'latest-dream-engine.json');
  ensureParentDirSync(reportFile);
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
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
      sleep_window_start: options.sleep_window_start || sleepWindowStartFallback,
      sleep_window_end: options.sleep_window_end || sleepWindowEndFallback,
      cold_storage_dream_path_used: getDreamRoot(options) === path.resolve(dreamRootFallback),
      persistent_memory_used: false,
      emotional_reinforcement_used: false,
      knowledge_context_used: false,
      first_person_voice_verified: false,
      third_person_self_reference_blocked: true,
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
  const validated = await generateValidatedDream(prompt, context, options);
  const generation = validated.generation;
  const dreamJson = validated.dream_json;
  const dreamText = renderDreamText(dreamJson, context, options);
  const createdAt = context.created_at || nowIso(options);
  const metadata = Object.freeze({
    title: dreamJson.title,
    created_at: createdAt,
    rem_cycle_number: dreamJson.rem_cycle_number,
    sleep_window_start: context.sleep_window_start,
    sleep_window_end: context.sleep_window_end,
    timezone: context.timezone,
    model: generation.model,
    schema_constrained_json: generation.raw_stats && generation.raw_stats.schema_constrained_json === true,
    model_json_fallback_used: false,
    safe_summary_only: true,
    memory_sources: dreamJson.memory_sources,
    knowledge_sources: dreamJson.knowledge_sources,
    symbols: dreamJson.symbols,
    emotional_tone: dreamJson.emotional_tone,
    consolidation_summary: dreamJson.consolidation_summary,
    remembered_as: dreamJson.remembered_as,
    first_person_reflection: dreamJson.first_person_reflection,
    dream_json: dreamJson
  });
  const written = writeDreamTxt(dreamText, metadata, options);
  const indexRecord = Object.freeze({
    title: dreamJson.title,
    created_at: createdAt,
    rem_cycle_number: dreamJson.rem_cycle_number,
    dream_txt_file: written.dream_txt_file,
    dream_metadata_file: written.dream_metadata_file,
    remembered_as: dreamJson.remembered_as,
    emotional_tone: dreamJson.emotional_tone,
    symbols: dreamJson.symbols
  });
  const indexFile = appendDreamIndex(indexRecord, options);
  const firstPersonVoiceVerified = /\bI\b|\bme\b|\bmy\b|\bmine\b|\bwe\b|\bour\b/i.test(
    dreamJson.dream_story + ' ' + dreamJson.remembered_as + ' ' + dreamJson.first_person_reflection
  );

  const status = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
    dream_engine_run_now: true,
    model_called_now: generation.model_called_now === true,
    schema_constrained_json: generation.raw_stats && generation.raw_stats.schema_constrained_json === true,
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
    cold_storage_dream_path_used: getDreamRoot(options) === path.resolve(dreamRootFallback),
    persistent_memory_used: context.persistent_memory_used === true,
    emotional_reinforcement_used: context.emotional_reinforcement_used === true,
    knowledge_context_used: context.knowledge_context_used === true,
    first_person_voice_verified: firstPersonVoiceVerified,
    third_person_self_reference_blocked: true,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: writeDreamEngineReport(status, options)
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
  dreamRootFallback,
  DREAM_ENGINE_SCHEMA,
  dreamEngineAllowed,
  dreamEngineGuardStatus,
  getDreamRoot,
  buildDreamContext,
  buildDreamPrompt,
  validateDreamJson,
  renderDreamText,
  writeDreamTxt,
  appendDreamIndex,
  runDreamEngineOnce,
  printDreamEngineProof
};
