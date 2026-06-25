'use strict';

const path = require('node:path');

const { createChatMemorySubstrate } = require('./chat-memory-substrate.cjs');
const { getDreamRoot } = require('./dream-engine.cjs');
const { getDreamMemoryIndexFile } = require('./dream-memory-consolidation.cjs');
const { existsSync } = require('../util/fs-safe.cjs');
const { readJsonlSync } = require('../util/jsonl.cjs');
const { reconcileDreamArchive } = require('./dream-archive.cjs');
const { rejectPrivateReasoningMarkers } = require('../model/ollama-client.cjs');

function isDreamRecallQuestion(text) {
  const value = String(text || '').toLowerCase();

  if (!value.trim()) {
    return false;
  }

  return /\b(did|do|what|remember|last|mean|meaning|about)\b/.test(value) &&
    /\b(dream|dreamed|dreamt|dreams|nightmare|rem)\b/.test(value);
}

function safeArray(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function safeText(value, limit = 600) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  rejectPrivateReasoningMarkers(text, 'dream recall text');
  return text.slice(0, limit);
}

function readDreamMemoryIndex(options = {}) {
  const dreamRoot = getDreamRoot(options);
  const archiveIndexFile = options.dream_index_file || path.join(dreamRoot, 'dream-index.jsonl');
  reconcileDreamArchive({ ...options, dream_root: dreamRoot, index_file: archiveIndexFile });
  const memoryIndexFile = options.dream_memory_index_file || getDreamMemoryIndexFile(options);
  const archiveRecords = existsSync(archiveIndexFile)
    ? readJsonlSync(archiveIndexFile).filter((record) => record && typeof record === 'object')
    : [];
  const memoryRecords = existsSync(memoryIndexFile)
    ? readJsonlSync(memoryIndexFile).filter((record) => record && typeof record === 'object')
    : [];
  const merged = new Map();
  for (const record of archiveRecords.concat(memoryRecords)) {
    const key = String(record.dream_id || record.id || record.dream_metadata_file || record.dream_txt_file || '');
    if (key && !merged.has(key)) merged.set(key, record);
  }
  return Array.from(merged.values());
}

function compactDreamIndexRecord(record) {
  return Object.freeze({
    dream_title: safeText(record.dream_title || record.title, 160),
    dream_summary: safeText(record.dream_summary || record.remembered_as, 500),
    emotional_tone: safeText(record.emotional_tone, 260),
    symbols: safeArray(record.symbols, 8),
    source_memories: safeArray(record.source_memories || record.memory_sources, 6),
    source_knowledge: safeArray(record.source_knowledge || record.knowledge_sources, 6),
    dream_txt_file: safeText(record.dream_txt_file, 500),
    dream_metadata_file: safeText(record.dream_metadata_file, 500),
    persistent_memory_id: safeText(record.persistent_memory_id, 120),
    dream_created_at: safeText(record.dream_created_at || record.created_at, 80)
  });
}

function compactDreamMemoryMatch(match) {
  const memory = match && match.memory ? match.memory : match;

  return Object.freeze({
    memory_id: safeText(memory && memory.id, 120),
    summary: safeText(memory && (memory.summary || memory.text), 500),
    tags: safeArray(memory && memory.tags, 12),
    category: safeText(memory && memory.category, 80),
    source: safeText(memory && memory.source, 80),
    score: Number((match && match.score) || 0)
  });
}

function retrieveDreamMemoryContext(options = {}) {
  const userText = String(options.user_text || options.text || '').trim();
  const dreamRecallQuestion = options.force === true || isDreamRecallQuestion(userText);
  const dreamRoot = getDreamRoot(options);
  const substrate = options.memory_substrate || createChatMemorySubstrate({
    base_dir: options.memory_base_dir
  });

  if (!dreamRecallQuestion) {
    return Object.freeze({
      dream_retrieval_run_now: false,
      dream_recall_question: false,
      dream_memory_context_used: false,
      has_dreams: false,
      recent_dreams: [],
      dream_memory_matches: [],
      latest_dream_file: null,
      dream_file_reference_available: false,
      invented_dream: false,
      dream_root: dreamRoot,
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  substrate.ensureReady();

  const recall = substrate.recallContext({
    text: [
      userText,
      'dream sleep rem remembered_as dream-memory consolidation'
    ].join(' '),
    limit: Number(options.limit || 8)
  });

  const indexRecords = readDreamMemoryIndex(options)
    .slice(-Math.max(1, Math.min(10, Number(options.limit || 5))));

  const longMatches = Array.isArray(recall.long_term_matches) ? recall.long_term_matches : [];

  const dreamMatches = longMatches
    .filter((match) => {
      const memory = match.memory || match;
      const tags = Array.isArray(memory.tags) ? memory.tags : [];

      return memory.category === 'dreams' ||
        tags.includes('dream') ||
        tags.includes('sleep') ||
        tags.includes('rem');
    })
    .map(compactDreamMemoryMatch)
    .slice(0, 5);

  const recentDreams = indexRecords
    .map(compactDreamIndexRecord)
    .filter((record) => record.dream_title || record.dream_summary);

  const latest = recentDreams.length > 0 ? recentDreams[recentDreams.length - 1] : null;
  const hasDreams = recentDreams.length > 0 || dreamMatches.length > 0;

  return Object.freeze({
    dream_retrieval_run_now: true,
    dream_recall_question: true,
    dream_memory_context_used: hasDreams,
    has_dreams: hasDreams,
    recent_dreams: recentDreams,
    dream_memory_matches: dreamMatches,
    latest_dream_file: latest && latest.dream_txt_file ? latest.dream_txt_file : null,
    dream_file_reference_available: Boolean(latest && latest.dream_txt_file),
    invented_dream: false,
    dream_root: path.resolve(dreamRoot),
    chat_mode_only: true,
    game_mode_started: false
  });
}

module.exports = {
  isDreamRecallQuestion,
  readDreamMemoryIndex,
  compactDreamIndexRecord,
  compactDreamMemoryMatch,
  retrieveDreamMemoryContext
};
