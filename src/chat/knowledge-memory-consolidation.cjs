'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createChatMemorySubstrate } = require('./chat-memory-substrate.cjs');
const { loadKnowledgeChunks } = require('./knowledge-context.cjs');
const { getKnowledgeConfig } = require('../config/floki-config.cjs');
const { writeJsonFileAtomicSync } = require('../util/fs-safe.cjs');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function compactText(value, maxChars) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function safeTag(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

function sourceLabel(chunk) {
  return compactText(
    chunk.title ||
    chunk.channel_folder ||
    chunk.source_collection ||
    chunk.video_id ||
    'saved knowledge',
    180
  );
}

function consolidationSource(chunk) {
  return chunk.source_type === 'youtube_transcript' ||
    chunk.source_type === 'transcript_manifest'
    ? 'youtube_knowledge_consolidation'
    : 'media_text_knowledge_consolidation';
}

function memoryTextForChunk(chunk, maxChars) {
  const title = sourceLabel(chunk);
  const channel = compactText(chunk.channel_folder, 120);
  const excerpt = compactText(chunk.text, maxChars);
  const origin = channel ? ' from ' + channel : '';
  return 'I remember reading “' + title + '”' + origin + '. What I learned from that part was: ' + excerpt;
}

function runKnowledgeMemoryConsolidation(options = {}) {
  const config = getKnowledgeConfig('chat');
  if (config.sleep_consolidation_enabled !== true) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_KNOWLEDGE_MEMORY_CONSOLIDATION_DISABLED',
      consolidation_run_now: false,
      knowledge_chunks_available: 0,
      memories_written: 0,
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const substrate = options.memory_substrate || createChatMemorySubstrate({ base_dir: options.memory_base_dir });
  substrate.ensureReady();
  const shortTerm = substrate.consolidate({ min_importance: options.min_importance });
  const chunks = Array.isArray(options.knowledge_chunks) ? options.knowledge_chunks : loadKnowledgeChunks(options);
  const existing = readJsonl(substrate.paths.long_term_jsonl);
  const existingChunkIds = new Set(existing
    .filter((memory) => memory && (
      memory.source === 'youtube_knowledge_consolidation' ||
      memory.source === 'media_text_knowledge_consolidation'
    ))
    .map((memory) => memory.source_event_id)
    .filter(Boolean));
  const limit = Math.max(1, Number(options.max_chunks || config.sleep_consolidation_max_chunks_per_night));
  const summaryChars = Math.max(120, Number(options.summary_chars || config.sleep_consolidation_summary_chars));
  const candidates = chunks
    .filter((chunk) => chunk && typeof chunk.text === 'string' && chunk.text.trim())
    .filter((chunk) => chunk.chunk_id && !existingChunkIds.has(chunk.chunk_id))
    .slice(0, limit);
  const written = [];

  for (const chunk of candidates) {
    const channelTag = safeTag(chunk.channel_folder ? 'channel:' + chunk.channel_folder : '');
    const collectionTag = safeTag(chunk.source_collection ? 'collection:' + chunk.source_collection : '');
    const sourceTypeTag = safeTag(chunk.source_type ? 'source_type:' + chunk.source_type : '');
    const videoTag = safeTag(chunk.video_id ? 'video:' + chunk.video_id : '');
    const record = substrate.rememberLongTerm({
      category: 'semantic_facts',
      text: memoryTextForChunk(chunk, summaryChars),
      summary: memoryTextForChunk(chunk, Math.min(summaryChars, 700)),
      tags: ['text_knowledge', 'read', 'learned', 'knowledge_consolidation', collectionTag, sourceTypeTag, channelTag, videoTag].filter(Boolean),
      importance: 0.68,
      confidence: 0.96,
      emotion: { curiosity: 0.25, hope: 0.08, trust: 0.05 },
      source: consolidationSource(chunk),
      source_event_id: chunk.chunk_id
    });
    written.push(record);
  }

  const status = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_MEMORY_CONSOLIDATION_PASS',
    consolidation_run_now: true,
    short_term_memories_promoted: Number(shortTerm.promoted_count || 0),
    knowledge_chunks_available: chunks.length,
    unconsolidated_chunks_found: candidates.length,
    memories_written: written.length,
    memory_ids: Object.freeze(written.map((memory) => memory.id)),
    source_chunk_ids: Object.freeze(written.map((memory) => memory.source_event_id)),
    chat_mode_only: true,
    game_mode_started: false
  });

  if (options.report_file) writeJsonFileAtomicSync(path.resolve(options.report_file), status);
  return status;
}

module.exports = {
  compactText,
  memoryTextForChunk,
  consolidationSource,
  runKnowledgeMemoryConsolidation
};
