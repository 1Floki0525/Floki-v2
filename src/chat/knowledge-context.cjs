'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getKnowledgePaths } = require('./knowledge-ingestion.cjs');
const { existsSync } = require('../util/fs-safe.cjs');
const { readJsonlSync } = require('../util/jsonl.cjs');

function normalize(value) {
  return String(value || '').toLowerCase();
}

function scoreChunk(chunk, query) {
  const q = normalize(query);
  const text = normalize([chunk.title, chunk.text, chunk.channel_folder].join(' '));
  if (!q.trim()) return Number(chunk.created_at ? Date.parse(chunk.created_at) || 0 : 0) / 10000000000000;
  const words = q.split(/\s+/).filter((word) => word.length >= 4).slice(0, 16);
  let score = 0;
  for (const word of words) {
    if (text.includes(word)) score += 1;
  }
  if (chunk.source_type === 'youtube_transcript') score += 0.25;
  return score;
}

function loadKnowledgeChunks(options = {}) {
  const paths = getKnowledgePaths(options);
  if (!existsSync(paths.chunks_jsonl)) return [];
  return readJsonlSync(paths.chunks_jsonl);
}

function retrieveKnowledgeContext(query, options = {}) {
  const chunks = loadKnowledgeChunks(options);
  const limit = Math.max(1, Math.min(12, Number(options.limit || 6)));
  const scored = chunks
    .filter((chunk) => chunk && typeof chunk.text === 'string')
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query) }))
    .filter((item) => item.score > 0 || !String(query || '').trim())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return Object.freeze({
    knowledge_retrieval_run_now: true,
    persistent_knowledge_used: chunks.length > 0,
    knowledge_chunk_count_total: chunks.length,
    knowledge_matches: scored.map((item) => Object.freeze({
      chunk_id: item.chunk.chunk_id || null,
      source_type: item.chunk.source_type || null,
      title: item.chunk.title || null,
      channel_folder: item.chunk.channel_folder || null,
      video_id: item.chunk.video_id || null,
      source_path: item.chunk.source_path || null,
      summary: String(item.chunk.text || '').slice(0, Number(options.summary_chars || 450)),
      score: item.score
    })),
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}

module.exports = { loadKnowledgeChunks, retrieveKnowledgeContext };
