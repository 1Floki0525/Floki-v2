'use strict';

const {
  statePath,
  ensureDirSync,
  ensureParentDirSync,
  existsSync,
  appendTextFileSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');

const { newId } = require('../util/ids.cjs');
const { CHAT_MODE_LIVING_CONTRACT } = require('./chat-mode-living-contract.cjs');

const CHAT_MEMORY_SUBSTRATE_VERSION = 'floki-v2-chat-memory-substrate-v1';

const EMOTION_DIMENSIONS = Object.freeze([
  'valence',
  'arousal',
  'trust',
  'fear',
  'curiosity',
  'hope',
  'confidence',
  'frustration',
  'attachment',
  'uncertainty'
]);

const LONG_TERM_CATEGORIES = Object.freeze([
  'autobiographical_memories',
  'semantic_facts',
  'relationship_history',
  'beliefs',
  'biases',
  'preferences',
  'likes',
  'dislikes',
  'hopes',
  'dreams',
  'goals',
  'skills',
  'emotional_lessons'
]);

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback = 0) {
  const chosen = typeof value === 'number' ? value : fallback;

  if (!Number.isFinite(chosen)) {
    return fallback;
  }

  return Math.max(-1, Math.min(1, chosen));
}

function clamp01(value, fallback = 0.5) {
  const chosen = typeof value === 'number' ? value : fallback;

  if (!Number.isFinite(chosen)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, chosen));
}

function sanitizeText(value, fieldName = 'text') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(fieldName + ' must be a non-empty string');
  }

  const trimmed = value.trim();

  if (trimmed.length > 4000) {
    throw new Error(fieldName + ' is too long');
  }

  const lower = trimmed.toLowerCase();
  const banned = [
    '<think>',
    '</think>',
    'chain_of_thought',
    'hidden_reasoning',
    'raw_reasoning',
    'scratchpad'
  ];

  for (const marker of banned) {
    if (lower.includes(marker)) {
      throw new Error(fieldName + ' contains banned private reasoning marker: ' + marker);
    }
  }

  return trimmed;
}

function normalizeTag(tag) {
  return String(tag || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const normalized = [];

  for (const tag of tags) {
    const safe = normalizeTag(tag);
    if (safe && !normalized.includes(safe)) {
      normalized.push(safe);
    }
  }

  return normalized;
}

function normalizeEmotionScores(input = {}) {
  const out = {};

  for (const dimension of EMOTION_DIMENSIONS) {
    out[dimension] = clampScore(input[dimension], 0);
  }

  return out;
}

function defaultPaths(baseDir) {
  const base = baseDir || statePath('chat/memory');

  return Object.freeze({
    base,
    short_term_jsonl: base + '/short-term.jsonl',
    long_term_jsonl: base + '/long-term.jsonl',
    emotional_scores_json: base + '/emotional-scores.json',
    reinforcement_jsonl: base + '/reinforcement-events.jsonl',
    consolidation_jsonl: base + '/consolidation-log.jsonl',
    recall_context_json: base + '/latest-recall-context.json'
  });
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = require('node:fs').readFileSync(filePath, 'utf8').trim();

  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(filePath, record) {
  ensureParentDirSync(filePath);
  appendTextFileSync(filePath, JSON.stringify(record) + '\n');
  return record;
}

function tokenSet(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3);

  return new Set(words);
}

function overlapScore(aText, bText) {
  const a = tokenSet(aText);
  const b = tokenSet(bText);

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let hits = 0;

  for (const token of a) {
    if (b.has(token)) {
      hits += 1;
    }
  }

  return hits / Math.max(a.size, b.size);
}

function createMemoryRecord(input) {
  const text = sanitizeText(input.text, 'memory text');
  const tags = normalizeTags(input.tags);
  const emotion = normalizeEmotionScores(input.emotion || {});
  const createdAt = input.created_at || nowIso();

  return Object.freeze({
    id: input.id || newId('chatmem'),
    substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
    stream: input.stream,
    category: input.category || 'autobiographical_memories',
    text,
    summary: sanitizeText(input.summary || text, 'memory summary'),
    tags,
    importance: clamp01(input.importance, 0.5),
    confidence: clamp01(input.confidence, 1),
    emotion,
    reinforcement_score: clampScore(input.reinforcement_score, 0),
    source: input.source || 'chat',
    source_event_id: input.source_event_id || null,
    source_memory_id: input.source_memory_id || null,
    consolidated_from: Array.isArray(input.consolidated_from) ? input.consolidated_from.slice() : [],
    created_at: createdAt,
    updated_at: createdAt,
    access_count: 0,
    last_accessed_at: null
  });
}

function createDefaultEmotionState() {
  const current = {};
  const targets = {};

  for (const dimension of EMOTION_DIMENSIONS) {
    current[dimension] = 0;
  }

  return Object.freeze({
    substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
    updated_at: nowIso(),
    dimensions: EMOTION_DIMENSIONS.slice(),
    current,
    targets
  });
}

function createChatMemorySubstrate(options = {}) {
  const paths = defaultPaths(options.base_dir);

  function ensureReady() {
    ensureDirSync(paths.base);

    if (!existsSync(paths.emotional_scores_json)) {
      writeJsonFileAtomicSync(paths.emotional_scores_json, createDefaultEmotionState());
    }

    if (!existsSync(paths.short_term_jsonl)) {
      ensureParentDirSync(paths.short_term_jsonl);
      require('node:fs').writeFileSync(paths.short_term_jsonl, '', 'utf8');
    }

    if (!existsSync(paths.long_term_jsonl)) {
      ensureParentDirSync(paths.long_term_jsonl);
      require('node:fs').writeFileSync(paths.long_term_jsonl, '', 'utf8');
    }

    return paths;
  }

  function rememberShortTerm(input) {
    ensureReady();

    const record = createMemoryRecord({
      ...input,
      stream: 'short_term',
      category: input.category || 'autobiographical_memories',
      tags: normalizeTags(['short_term', 'chat'].concat(input.tags || []))
    });

    return appendJsonl(paths.short_term_jsonl, record);
  }

  function rememberLongTerm(input) {
    ensureReady();

    if (!LONG_TERM_CATEGORIES.includes(input.category || 'autobiographical_memories')) {
      throw new Error('invalid long-term memory category: ' + input.category);
    }

    const record = createMemoryRecord({
      ...input,
      stream: 'long_term',
      tags: normalizeTags(['long_term', 'chat'].concat(input.tags || []))
    });

    return appendJsonl(paths.long_term_jsonl, record);
  }

  function loadEmotionState() {
    ensureReady();
    return readJsonFileSync(paths.emotional_scores_json, createDefaultEmotionState());
  }

  function saveEmotionState(state) {
    const next = {
      substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
      updated_at: nowIso(),
      dimensions: EMOTION_DIMENSIONS.slice(),
      current: normalizeEmotionScores(state.current || {}),
      targets: state.targets || {}
    };

    writeJsonFileAtomicSync(paths.emotional_scores_json, next);
    return next;
  }

  function reinforce(input) {
    ensureReady();

    const targetType = normalizeTag(input.target_type || 'belief');
    const targetKey = normalizeTag(input.target_key || input.target || 'unknown');
    const reason = sanitizeText(input.reason || 'reinforcement update', 'reinforcement reason');
    const signal = clampScore(input.signal, 0);
    const emotion = normalizeEmotionScores(input.emotion || {});
    const state = loadEmotionState();
    const targetId = targetType + ':' + targetKey;

    const previous = state.targets[targetId] || {
      target_type: targetType,
      target_key: targetKey,
      score: 0,
      evidence_count: 0,
      last_reason: ''
    };

    const nextScore = clampScore(previous.score + signal);
    state.targets[targetId] = {
      target_type: targetType,
      target_key: targetKey,
      score: nextScore,
      evidence_count: Number(previous.evidence_count || 0) + 1,
      last_reason: reason,
      updated_at: nowIso()
    };

    for (const dimension of EMOTION_DIMENSIONS) {
      state.current[dimension] = clampScore(
        Number(state.current[dimension] || 0) + Number(emotion[dimension] || 0) * 0.25
      );
    }

    const saved = saveEmotionState(state);
    const event = {
      id: newId('reinforce'),
      substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
      target_id: targetId,
      target_type: targetType,
      target_key: targetKey,
      signal,
      emotion,
      resulting_score: nextScore,
      reason,
      created_at: nowIso()
    };

    appendJsonl(paths.reinforcement_jsonl, event);

    return Object.freeze({
      event,
      emotional_state: saved
    });
  }

  function shouldConsolidate(memory, options = {}) {
    const minImportance = typeof options.min_importance === 'number' ? options.min_importance : 0.65;
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    const emotion = memory.emotion || {};

    const emotionalWeight = Math.max(
      Math.abs(Number(emotion.valence || 0)),
      Math.abs(Number(emotion.trust || 0)),
      Math.abs(Number(emotion.hope || 0)),
      Math.abs(Number(emotion.fear || 0)),
      Math.abs(Number(emotion.attachment || 0))
    );

    const importantTags = [
      'identity',
      'relationship',
      'belief',
      'bias',
      'preference',
      'like',
      'dislike',
      'hope',
      'dream',
      'goal',
      'skill',
      'emotional_lesson',
      'hearing_to_cognition'
    ];

    return memory.importance >= minImportance ||
      emotionalWeight >= 0.5 ||
      tags.some((tag) => importantTags.includes(tag));
  }

  function consolidate(options = {}) {
    ensureReady();

    const shortTerm = readJsonl(paths.short_term_jsonl);
    const longTerm = readJsonl(paths.long_term_jsonl);
    const existingSources = new Set();

    for (const memory of longTerm) {
      if (Array.isArray(memory.consolidated_from)) {
        for (const sourceId of memory.consolidated_from) {
          existingSources.add(sourceId);
        }
      }

      if (memory.source_memory_id) {
        existingSources.add(memory.source_memory_id);
      }
    }

    const promoted = [];

    for (const memory of shortTerm) {
      if (existingSources.has(memory.id)) {
        continue;
      }

      if (!shouldConsolidate(memory, options)) {
        continue;
      }

      const category = LONG_TERM_CATEGORIES.includes(memory.category)
        ? memory.category
        : 'autobiographical_memories';

      const longRecord = rememberLongTerm({
        category,
        text: memory.text,
        summary: memory.summary,
        tags: normalizeTags((memory.tags || []).concat(['consolidated'])),
        importance: memory.importance,
        confidence: memory.confidence,
        emotion: memory.emotion,
        reinforcement_score: memory.reinforcement_score,
        source: 'chat_memory_consolidation',
        source_memory_id: memory.id,
        consolidated_from: [memory.id]
      });

      promoted.push(longRecord);

      appendJsonl(paths.consolidation_jsonl, {
        id: newId('consolidate'),
        substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
        source_memory_id: memory.id,
        long_term_memory_id: longRecord.id,
        reason: 'importance_or_emotion_threshold',
        created_at: nowIso()
      });
    }

    return Object.freeze({
      promoted_count: promoted.length,
      promoted
    });
  }

  function recallContext(input = {}) {
    ensureReady();

    const query = sanitizeText(input.text || 'chat context', 'recall query');
    const limit = Math.max(1, Math.min(20, Number(input.limit || 8)));
    const shortTerm = readJsonl(paths.short_term_jsonl);
    const longTerm = readJsonl(paths.long_term_jsonl);
    const emotionalState = loadEmotionState();

    function score(memory, streamBoost) {
      const tagText = Array.isArray(memory.tags) ? memory.tags.join(' ') : '';
      const textScore = overlapScore(query, memory.text + ' ' + memory.summary);
      const tagScore = overlapScore(query, tagText);
      const importance = Number(memory.importance || 0);
      const reinforcement = Math.abs(Number(memory.reinforcement_score || 0));

      return textScore * 0.45 + tagScore * 0.2 + importance * 0.25 + reinforcement * 0.05 + streamBoost;
    }

    const shortMatches = shortTerm
      .map((memory) => ({ memory, score: score(memory, 0.08) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const longMatches = longTerm
      .map((memory) => ({ memory, score: score(memory, 0.12) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const context = {
      ok: true,
      marker: 'FLOKI_V2_CHAT_MEMORY_RECALL_CONTEXT_READY',
      substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
      query,
      short_term_matches: shortMatches,
      long_term_matches: longMatches,
      emotional_state: emotionalState,
      persistent_short_term_memory: true,
      persistent_long_term_memory: true,
      emotional_scoring_available: true,
      recall_ready_for_cognition: true,
      created_at: nowIso()
    };

    writeJsonFileAtomicSync(paths.recall_context_json, context);
    return Object.freeze(context);
  }

  function status() {
    ensureReady();

    const shortTerm = readJsonl(paths.short_term_jsonl);
    const longTerm = readJsonl(paths.long_term_jsonl);
    const emotionState = loadEmotionState();

    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_CHAT_MEMORY_SUBSTRATE_PASS',
      substrate_version: CHAT_MEMORY_SUBSTRATE_VERSION,
      contract_version: CHAT_MODE_LIVING_CONTRACT.contract_version,
      base_dir: paths.base,
      short_term_path: paths.short_term_jsonl,
      long_term_path: paths.long_term_jsonl,
      emotional_scores_path: paths.emotional_scores_json,
      reinforcement_path: paths.reinforcement_jsonl,
      consolidation_path: paths.consolidation_jsonl,
      recall_context_path: paths.recall_context_json,
      short_term_count: shortTerm.length,
      long_term_count: longTerm.length,
      emotional_target_count: Object.keys(emotionState.targets || {}).length,
      persistent_short_term_memory: true,
      persistent_long_term_memory: true,
      memory_consolidation_available: true,
      emotional_reinforcement_available: true,
      recall_context_available: true,
      chat_mode_only: true
    });
  }

  return Object.freeze({
    paths,
    ensureReady,
    rememberShortTerm,
    rememberLongTerm,
    loadEmotionState,
    saveEmotionState,
    reinforce,
    shouldConsolidate,
    consolidate,
    recallContext,
    status
  });
}

function runChatMemorySubstrateProof(options = {}) {
  const substrate = createChatMemorySubstrate(options);
  substrate.ensureReady();

  const short = substrate.rememberShortTerm({
    text: 'Hey Floki, remember that trust, hope, and direct conversation with Binary-God matter to your growth.',
    summary: 'Binary-God told Floki that trust, hope, and direct conversation matter to his growth.',
    tags: ['relationship', 'trust', 'hope', 'growth', 'belief'],
    importance: 0.92,
    emotion: {
      valence: 0.4,
      trust: 0.7,
      hope: 0.8,
      attachment: 0.5,
      curiosity: 0.4
    },
    category: 'relationship_history'
  });

  const reinforcement = substrate.reinforce({
    target_type: 'belief',
    target_key: 'trust_with_binary_god_supports_growth',
    signal: 0.35,
    reason: 'A trusted direct conversation should strengthen Floki\'s belief that relationship memory matters.',
    emotion: {
      trust: 0.4,
      hope: 0.3,
      attachment: 0.2
    }
  });

  const consolidation = substrate.consolidate({
    min_importance: 0.65
  });

  const recall = substrate.recallContext({
    text: 'trust hope Binary-God growth',
    limit: 5
  });

  const status = substrate.status();

  const ok = status.ok === true &&
    short.stream === 'short_term' &&
    reinforcement.event.resulting_score > 0 &&
    consolidation.promoted_count >= 1 &&
    recall.long_term_matches.length >= 1 &&
    status.persistent_short_term_memory === true &&
    status.persistent_long_term_memory === true &&
    status.emotional_reinforcement_available === true &&
    status.chat_mode_only === true;

  return Object.freeze({
    ...status,
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_MEMORY_SUBSTRATE_PASS' : 'FLOKI_V2_CHAT_MEMORY_SUBSTRATE_FAIL',
    proof_short_term_memory_id: short.id,
    proof_reinforcement_target: reinforcement.event.target_id,
    proof_reinforcement_score: reinforcement.event.resulting_score,
    proof_promoted_count: consolidation.promoted_count,
    proof_recall_short_matches: recall.short_term_matches.length,
    proof_recall_long_matches: recall.long_term_matches.length
  });
}

if (require.main === module) {
  const status = runChatMemorySubstrateProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }
}

module.exports = {
  CHAT_MEMORY_SUBSTRATE_VERSION,
  EMOTION_DIMENSIONS,
  LONG_TERM_CATEGORIES,
  nowIso,
  clampScore,
  clamp01,
  sanitizeText,
  normalizeTag,
  normalizeTags,
  normalizeEmotionScores,
  defaultPaths,
  readJsonl,
  appendJsonl,
  tokenSet,
  overlapScore,
  createMemoryRecord,
  createDefaultEmotionState,
  createChatMemorySubstrate,
  runChatMemorySubstrateProof
};
