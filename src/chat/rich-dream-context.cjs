'use strict';

const path = require('node:path');

const {
  statePath,
  existsSync,
  readJsonFileSync
} = require('../util/fs-safe.cjs');
const { readJsonlSync } = require('../util/jsonl.cjs');
const { createChatMemorySubstrate } = require('./chat-memory-substrate.cjs');
const { loadKnowledgeChunks } = require('./knowledge-context.cjs');
const { getPathConfig, getDreamConfig, getSleepConfig } = require('../config/floki-config.cjs');

const PRIORITY_CATEGORIES = Object.freeze([
  'beliefs',
  'biases',
  'hopes',
  'goals',
  'relationship_history',
  'autobiographical_memories',
  'preferences',
  'likes',
  'dislikes',
  'fears',
  'emotional_lessons',
  'dreams',
  'semantic_facts',
  'skills'
]);

function safeReadJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return readJsonFileSync(file, fallback);
}

function safeReadJsonl(file) {
  if (!existsSync(file)) return [];
  return readJsonlSync(file);
}

function cleanText(value, max = 700) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function uniqueStrings(values, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function tokenSet(value) {
  return new Set(
    cleanText(value, 12000)
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4)
  );
}

function tokenOverlap(a, b) {
  const left = a instanceof Set ? a : tokenSet(a);
  const right = b instanceof Set ? b : tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / Math.max(1, Math.min(left.size, right.size));
}

function emotionMagnitude(emotion) {
  const values = Object.values(emotion && typeof emotion === 'object' ? emotion : {})
    .map(Number)
    .filter(Number.isFinite)
    .map(Math.abs);
  return values.length ? Math.max(...values) : 0;
}

function memoryTime(memory) {
  const raw = memory && (memory.updated_at || memory.created_at);
  const parsed = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function categoryPriority(category) {
  const index = PRIORITY_CATEGORIES.indexOf(String(category || ''));
  return index < 0 ? 0 : (PRIORITY_CATEGORIES.length - index) / PRIORITY_CATEGORIES.length;
}

function memorySalience(memory, nowMs) {
  const ageHours = Math.max(0, (nowMs - memoryTime(memory)) / 3600000);
  const recency = Math.max(0, 1 - ageHours / (24 * 14));
  return (
    Number(memory && memory.importance || 0) * 0.30 +
    Math.abs(Number(memory && memory.reinforcement_score || 0)) * 0.15 +
    emotionMagnitude(memory && memory.emotion) * 0.20 +
    categoryPriority(memory && memory.category) * 0.20 +
    recency * 0.15
  );
}

function compactMemory(memory) {
  return Object.freeze({
    id: memory && memory.id ? memory.id : null,
    stream: memory && memory.stream ? memory.stream : null,
    category: memory && memory.category ? memory.category : 'autobiographical_memories',
    summary: cleanText(memory && (memory.summary || memory.text), 650),
    tags: uniqueStrings(memory && memory.tags, 12),
    importance: Number(memory && memory.importance || 0),
    reinforcement_score: Number(memory && memory.reinforcement_score || 0),
    emotion: memory && memory.emotion && typeof memory.emotion === 'object' ? memory.emotion : {},
    source: memory && memory.source ? memory.source : null,
    created_at: memory && memory.created_at ? memory.created_at : null,
    updated_at: memory && memory.updated_at ? memory.updated_at : null
  });
}

function selectRecentMemories(records, nowMs, hours, limit) {
  const cutoff = nowMs - Number(hours) * 3600000;
  const ordered = records
    .filter((memory) => memory && cleanText(memory.summary || memory.text))
    .slice()
    .sort((a, b) => memoryTime(b) - memoryTime(a));
  const recent = ordered.filter((memory) => memoryTime(memory) >= cutoff);
  return (recent.length ? recent : ordered).slice(0, limit).map(compactMemory);
}

function selectLongTermMemories(records, nowMs, limit) {
  const chosen = [];
  const categoryCounts = new Map();
  const ordered = records
    .filter((memory) => memory && cleanText(memory.summary || memory.text))
    .map((memory) => ({ memory, score: memorySalience(memory, nowMs) }))
    .sort((a, b) => b.score - a.score);

  for (const item of ordered) {
    const category = String(item.memory.category || 'autobiographical_memories');
    const count = Number(categoryCounts.get(category) || 0);
    if (count >= 3) continue;
    chosen.push(compactMemory(item.memory));
    categoryCounts.set(category, count + 1);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

function personalityEntryNames(state, key, limit = 8) {
  const list = state && Array.isArray(state[key]) ? state[key] : [];
  return list
    .slice()
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
    .map((entry) => cleanText(entry && (entry.name || entry.text || entry.summary), 180))
    .filter(Boolean)
    .slice(0, limit);
}

function summarizePersonality(state) {
  const traits = state && state.traits && typeof state.traits === 'object'
    ? Object.entries(state.traits)
      .map(([name, value]) => ({ name, value: Number(value || 0) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
    : [];

  return Object.freeze({
    traits,
    values: uniqueStrings(state && state.values, 12),
    likes: personalityEntryNames(state, 'likes'),
    dislikes: personalityEntryNames(state, 'dislikes'),
    fears: personalityEntryNames(state, 'fears'),
    hopes: personalityEntryNames(state, 'hopes'),
    dreams: personalityEntryNames(state, 'dreams'),
    opinions: personalityEntryNames(state, 'opinions')
  });
}

function beliefAndBiasThemes(longTermMemories, personality, emotionalState) {
  const memoryThemes = longTermMemories
    .filter((memory) => ['beliefs', 'biases', 'opinions', 'preferences', 'likes', 'dislikes'].includes(memory.category))
    .map((memory) => memory.summary);

  const targets = emotionalState && emotionalState.targets && typeof emotionalState.targets === 'object'
    ? Object.values(emotionalState.targets)
      .filter((target) => target && ['belief', 'bias', 'preference', 'value'].includes(String(target.target_type || '')))
      .sort((a, b) => Math.abs(Number(b.score || 0)) - Math.abs(Number(a.score || 0)))
      .map((target) => cleanText([
        target.target_type,
        target.target_key,
        target.last_reason
      ].filter(Boolean).join(': '), 260))
    : [];

  return uniqueStrings(
    memoryThemes
      .concat(personality.opinions)
      .concat(personality.values)
      .concat(targets),
    16
  );
}

function unresolvedThemes(longTermMemories, personality, explicit) {
  const goals = longTermMemories
    .filter((memory) => ['goals', 'hopes', 'fears'].includes(memory.category))
    .map((memory) => memory.summary);

  return uniqueStrings(
    (Array.isArray(explicit) ? explicit : [])
      .concat(personality.hopes)
      .concat(personality.fears)
      .concat(personality.dreams)
      .concat(goals),
    16
  );
}

function buildThemeTokens(memorySources, beliefsBiases, unresolved, personality) {
  return tokenSet([
    ...memorySources,
    ...beliefsBiases,
    ...unresolved,
    ...(personality.values || []),
    ...(personality.likes || []),
    ...(personality.dislikes || []),
    ...(personality.hopes || []),
    ...(personality.opinions || [])
  ].join(' '));
}

function scoreKnowledgeChunk(chunk, themes) {
  const text = [
    chunk && chunk.title,
    chunk && chunk.channel_folder,
    chunk && chunk.text
  ].filter(Boolean).join(' ');
  let score = tokenOverlap(themes, tokenSet(text));
  if (chunk && chunk.source_type === 'youtube_transcript') score += 0.18;
  if (chunk && chunk.title) score += 0.02;
  return score;
}

function deterministicIndex(seed, length) {
  if (length <= 0) return -1;
  let hash = 2166136261;
  for (const char of String(seed || 'dream')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % length;
}

function selectKnowledge(chunks, themes, limit, seed) {
  const scored = (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => chunk && typeof chunk.text === 'string' && cleanText(chunk.text))
    .map((chunk) => ({ chunk, score: scoreKnowledgeChunk(chunk, themes) }))
    .sort((a, b) => b.score - a.score);

  const chosen = [];
  const seenSources = new Set();

  for (const item of scored) {
    if (item.score <= 0) continue;
    const sourceKey = String(
      item.chunk.video_id ||
      item.chunk.source_path ||
      item.chunk.title ||
      item.chunk.chunk_id ||
      chosen.length
    );
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    chosen.push(item.chunk);
    if (chosen.length >= limit) break;
  }

  if (chosen.length === 0 && scored.length > 0) {
    const index = deterministicIndex(seed, scored.length);
    chosen.push(scored[index].chunk);
  }

  return chosen.slice(0, limit).map((chunk) => Object.freeze({
    chunk_id: chunk.chunk_id || null,
    source_type: chunk.source_type || null,
    title: cleanText(chunk.title || 'Untitled learned source', 180),
    channel_folder: cleanText(chunk.channel_folder, 120),
    video_id: chunk.video_id || null,
    summary: cleanText(chunk.text, 750)
  }));
}

function recentDreams(options, limit) {
  const dreamRoot = path.resolve(
    options.dream_root ||
    getPathConfig(options.mode || 'chat').dream_root
  );
  const indexFile = options.dream_index_file || path.join(dreamRoot, 'dream-index.jsonl');
  const records = safeReadJsonl(indexFile).slice(-limit).reverse();

  return records.map((record) => {
    let metadata = null;
    if (record && record.dream_metadata_file && existsSync(record.dream_metadata_file)) {
      metadata = safeReadJson(record.dream_metadata_file, null);
    }
    const dreamJson = metadata && metadata.dream_json ? metadata.dream_json : {};
    return Object.freeze({
      title: cleanText(record && record.title, 160),
      symbols: uniqueStrings(
        (record && record.symbols) ||
        (metadata && metadata.symbols) ||
        dreamJson.symbols,
        12
      ),
      story_opening: cleanText(dreamJson.dream_story, 420),
      created_at: record && record.created_at ? record.created_at : null
    });
  }).filter((record) => record.title || record.story_opening);
}

function makeSourceRecords(entries, prefix, limit = 24) {
  const records = [];
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const summary = cleanText(
      entry && typeof entry === 'object'
        ? entry.summary || entry.text
        : entry,
      700
    );
    const key = summary.toLowerCase();

    if (!summary || seen.has(key)) continue;
    seen.add(key);

    records.push(Object.freeze({
      id: prefix + String(records.length + 1),
      category: cleanText(
        entry && typeof entry === 'object'
          ? entry.category || 'uncategorized'
          : 'uncategorized',
        96
      ),
      summary,
      source_id: entry && typeof entry === 'object'
        ? entry.source_id || entry.id || null
        : null,
      source_type: entry && typeof entry === 'object'
        ? entry.source_type || null
        : null,
      title: entry && typeof entry === 'object'
        ? cleanText(entry.title, 180)
        : '',
      channel_folder: entry && typeof entry === 'object'
        ? cleanText(entry.channel_folder, 120)
        : ''
    }));

    if (records.length >= limit) break;
  }

  return records;
}

function buildMemorySourceRecords(input = {}, limit = 24) {
  const entries = [];

  for (const summary of Array.isArray(input.explicit) ? input.explicit : []) {
    entries.push({
      category: 'explicit_memory',
      summary
    });
  }

  for (const memory of Array.isArray(input.recent) ? input.recent : []) {
    entries.push({
      category: 'recent_' + String(memory.category || 'memory'),
      summary: memory.summary,
      source_id: memory.id
    });
  }

  for (const memory of Array.isArray(input.long_term) ? input.long_term : []) {
    entries.push({
      category: memory.category || 'long_term_memory',
      summary: memory.summary,
      source_id: memory.id
    });
  }

  for (const summary of Array.isArray(input.beliefs_biases) ? input.beliefs_biases : []) {
    entries.push({
      category: 'belief_or_bias',
      summary
    });
  }

  for (const value of Array.isArray(input.personality_values) ? input.personality_values : []) {
    entries.push({
      category: 'personality_value',
      summary: value
    });
  }

  for (const hope of Array.isArray(input.personality_hopes) ? input.personality_hopes : []) {
    entries.push({
      category: 'personality_hope',
      summary: hope
    });
  }

  for (const fear of Array.isArray(input.personality_fears) ? input.personality_fears : []) {
    entries.push({
      category: 'personality_fear',
      summary: fear
    });
  }

  for (const summary of Array.isArray(input.unresolved) ? input.unresolved : []) {
    entries.push({
      category: 'unresolved_concern_or_hope',
      summary
    });
  }

  return makeSourceRecords(entries, 'M', limit);
}

function buildKnowledgeSourceRecords(items, limit = 24) {
  return makeSourceRecords(
    (Array.isArray(items) ? items : []).map((item) => ({
      category: item.source_type || 'learned_knowledge',
      summary: [
        item.title,
        item.channel_folder,
        item.summary
      ].filter(Boolean).join(' — '),
      source_id: item.chunk_id || item.video_id || null,
      source_type: item.source_type || null,
      title: item.title || '',
      channel_folder: item.channel_folder || ''
    })),
    'K',
    limit
  );
}

function categoryMatches(category, wanted) {
  const value = String(category || '');
  return value === wanted || value.startsWith(wanted + '_');
}

function selectDiverseMemoryGrounding(records, limit) {
  const selected = [];
  const seen = new Set();
  const source = Array.isArray(records) ? records : [];

  function add(record) {
    if (!record || selected.length >= limit) return;
    const key = String(record.summary || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    selected.push(record);
  }

  const priorities = [
    'beliefs',
    'biases',
    'belief_or_bias',
    'relationship_history',
    'recent',
    'hopes',
    'goals',
    'fears',
    'personality_value',
    'personality_hope',
    'personality_fear',
    'unresolved_concern_or_hope',
    'autobiographical_memories',
    'emotional_lessons',
    'preferences',
    'likes',
    'dislikes'
  ];

  for (const wanted of priorities) {
    add(source.find((record) => categoryMatches(record.category, wanted)));
  }

  for (const record of source) add(record);
  return selected.slice(0, limit);
}

function buildDreamGroundingPlan(memoryRecords, knowledgeRecords, config, options = {}) {
  const memoryLimit = Math.max(
    1,
    Number(options.grounding_memory_limit || config.grounding_memory_limit || 6)
  );
  const knowledgeLimit = Math.max(
    0,
    Number(options.grounding_knowledge_limit || config.grounding_knowledge_limit || 3)
  );

  return Object.freeze({
    memory_records: selectDiverseMemoryGrounding(
      memoryRecords,
      memoryLimit
    ),
    knowledge_records: (Array.isArray(knowledgeRecords)
      ? knowledgeRecords
      : []
    ).slice(0, knowledgeLimit),
    runtime_owned: true,
    model_must_not_emit_source_ids: true
  });
}

function sourceLabels(records) {
  return (Array.isArray(records) ? records : []).map((record) => [
    record.id,
    record.category ? '[' + record.category + ']' : null,
    record.summary
  ].filter(Boolean).join(' '));
}

function buildRichDreamContext(options = {}) {
  const mode = options.mode || 'chat';
  const config = getDreamConfig(mode);
  const sleep = getSleepConfig(mode);
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const substrate = options.memory_substrate || createChatMemorySubstrate({
    base_dir: options.memory_base_dir
  });
  substrate.ensureReady();

  const shortTermRaw = Array.isArray(options.short_term_memories)
    ? options.short_term_memories
    : safeReadJsonl(substrate.paths.short_term_jsonl);
  const longTermRaw = Array.isArray(options.long_term_memories)
    ? options.long_term_memories
    : safeReadJsonl(substrate.paths.long_term_jsonl);

  const recent = selectRecentMemories(
    shortTermRaw,
    nowMs,
    Number(options.recent_memory_hours || config.recent_memory_hours),
    Number(options.recent_memory_limit || config.recent_memory_limit)
  );
  const longTerm = selectLongTermMemories(
    longTermRaw,
    nowMs,
    Number(options.long_term_memory_limit || config.long_term_memory_limit)
  );

  const emotionState = options.emotional_state || substrate.loadEmotionState();
  const personalityState = options.personality_state ||
    safeReadJson(statePath('personality.json'), {});
  const personality = summarizePersonality(personalityState || {});
  const beliefsBiases = beliefAndBiasThemes(longTerm, personality, emotionState);
  const unresolved = unresolvedThemes(
    longTerm,
    personality,
    options.unresolved_concerns_hopes
  );

  const explicitMemorySources = Array.isArray(options.memory_sources)
    ? options.memory_sources
    : [];
  const memorySourceRecords = buildMemorySourceRecords({
    explicit: explicitMemorySources,
    recent,
    long_term: longTerm,
    beliefs_biases: beliefsBiases,
    personality_values: personality.values,
    personality_hopes: personality.hopes,
    personality_fears: personality.fears,
    unresolved
  }, 24);
  const memoryTexts = memorySourceRecords.map((record) => record.summary);

  const themes = buildThemeTokens(
    memoryTexts,
    beliefsBiases,
    unresolved,
    personality
  );
  const knowledgeChunks = Array.isArray(options.knowledge_chunks)
    ? options.knowledge_chunks
    : loadKnowledgeChunks(options);
  const selectedKnowledge = selectKnowledge(
    knowledgeChunks,
    themes,
    Number(options.knowledge_limit || config.knowledge_limit),
    now.toISOString() + ':' + String(options.rem_cycle_number || 1)
  );

  const explicitKnowledge = Array.isArray(options.knowledge_sources)
    ? options.knowledge_sources.map((summary) => ({
      title: 'Explicit dream knowledge',
      summary: cleanText(summary, 750),
      source_type: 'explicit'
    }))
    : [];
  const knowledgeSourceRecords = buildKnowledgeSourceRecords(
    explicitKnowledge.concat(selectedKnowledge),
    24
  );
  const dreamGroundingPlan = buildDreamGroundingPlan(
    memorySourceRecords,
    knowledgeSourceRecords,
    config,
    options
  );

  const conversations = uniqueStrings(
    (Array.isArray(options.conversations) ? options.conversations : [])
      .concat(recent
        .filter((memory) => {
          const tags = new Set(memory.tags || []);
          return memory.source === 'chat' ||
            memory.source === 'spoken_reply_once' ||
            tags.has('chat') ||
            tags.has('conversation');
        })
        .map((memory) => memory.summary)),
    12
  );

  const recentDreamList = Array.isArray(options.recent_dreams)
    ? options.recent_dreams
    : recentDreams(options, Number(
      options.recent_dream_avoidance_count ||
      config.recent_dream_avoidance_count
    ));

  const daySummary = cleanText(
    options.day_summary ||
    recent.slice(0, 6).map((memory) => memory.summary).join(' | ') ||
    'No recent day memory was recorded; use long-term memory, personality, emotional state, and learned knowledge honestly.',
    1800
  );

  return Object.freeze({
    created_at: now.toISOString(),
    rem_cycle_number: Number(options.rem_cycle_number || 1),
    sleep_window_start: options.sleep_window_start || sleep.start_hhmm,
    sleep_window_end: options.sleep_window_end || sleep.end_hhmm,
    timezone: options.timezone || sleep.timezone,
    day_summary: daySummary,
    day_memories: recent,
    long_term_memories: longTerm,
    emotions: emotionState,
    personality,
    beliefs_biases: beliefsBiases,
    conversations,
    thoughts: uniqueStrings(options.thoughts, 8),
    unresolved_concerns_hopes: unresolved,
    memory_source_records: memorySourceRecords,
    knowledge_source_records: knowledgeSourceRecords,
    dream_grounding_plan: dreamGroundingPlan,
    memory_sources: sourceLabels(dreamGroundingPlan.memory_records),
    knowledge_sources: sourceLabels(dreamGroundingPlan.knowledge_records),
    available_memory_source_ids: dreamGroundingPlan.memory_records.map((record) => record.id),
    available_knowledge_source_ids: dreamGroundingPlan.knowledge_records.map((record) => record.id),
    recent_dreams_to_avoid: recentDreamList,
    persistent_memory_used: memorySourceRecords.length > 0,
    emotional_reinforcement_used: true,
    personality_used: true,
    beliefs_biases_used: beliefsBiases.length > 0,
    knowledge_context_used: knowledgeSourceRecords.length > 0,
    knowledge_chunk_count_total: knowledgeChunks.length,
    grounding_counts: Object.freeze({
      recent_memories: recent.length,
      long_term_memories: longTerm.length,
      memory_sources: dreamGroundingPlan.memory_records.length,
      knowledge_sources: dreamGroundingPlan.knowledge_records.length,
      beliefs_biases: beliefsBiases.length,
      unresolved_concerns_hopes: unresolved.length,
      recent_dreams_avoided: recentDreamList.length
    }),
    chat_mode_only: mode !== 'game',
    game_mode_started: false
  });
}

module.exports = {
  PRIORITY_CATEGORIES,
  cleanText,
  uniqueStrings,
  tokenSet,
  tokenOverlap,
  compactMemory,
  selectRecentMemories,
  selectLongTermMemories,
  summarizePersonality,
  beliefAndBiasThemes,
  unresolvedThemes,
  selectKnowledge,
  recentDreams,
  makeSourceRecords,
  buildMemorySourceRecords,
  buildKnowledgeSourceRecords,
  selectDiverseMemoryGrounding,
  buildDreamGroundingPlan,
  buildRichDreamContext
};
