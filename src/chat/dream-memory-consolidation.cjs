'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createChatMemorySubstrate } = require('./chat-memory-substrate.cjs');
const { DEFAULT_DREAM_ROOT, getDreamRoot } = require('./dream-engine.cjs');
const {
  ensureParentDirSync,
  existsSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const { appendJsonlSync, readJsonlSync } = require('../util/jsonl.cjs');
const { newId } = require('../util/ids.cjs');
const { rejectPrivateReasoningMarkers } = require('../model/ollama-client.cjs');
const { isThirdPersonSelfReference } = require('../../brain/broca/index.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const DREAM_MEMORY_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'dream-memory-consolidation');

function nowIso(options = {}) {
  if (typeof options.clock === 'function') {
    return new Date(options.clock()).toISOString();
  }
  if (options.now) {
    return new Date(options.now).toISOString();
  }
  return new Date().toISOString();
}

function dreamMemoryConsolidationAllowed(env = process.env) {
  return env.FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION === '1';
}

function dreamMemoryConsolidationGuardStatus(env = process.env) {
  const allowed = dreamMemoryConsolidationAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION=1',
    dream_memory_consolidation_run_now: false,
    dream_files_read: 0,
    dream_memories_written: 0,
    dream_memory_index_appended: false,
    persistent_chat_memory_updated: false,
    chat_mode_only: true,
    game_mode_started: false,
    reason: allowed
      ? 'Dream memory consolidation is explicitly allowed for this run.'
      : 'Dream memory consolidation is guarded and will not read dreams or write memory without FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION=1.'
  });
}

function getDreamMemoryIndexFile(options = {}) {
  return path.join(getDreamRoot(options), 'dream-memory-index.jsonl');
}

function getDreamIndexFile(options = {}) {
  return options.dream_index_file || path.join(getDreamRoot(options), 'dream-index.jsonl');
}

function safeArray(value, limit = 12) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function assertSafeText(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(fieldName + ' must be a non-empty string');
  }
  rejectPrivateReasoningMarkers(text, fieldName);
  return text;
}

function assertSafeDreamMemoryText(value, fieldName) {
  const text = assertSafeText(value, fieldName);
  if (isThirdPersonSelfReference(text) || /\bFloki\s+dreamed\b/i.test(text)) {
    throw new Error(fieldName + ' contains third-person self narration');
  }
  return text;
}

function dateTagFromIso(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function existingDreamMemoryKeys(options = {}) {
  const indexFile = getDreamMemoryIndexFile(options);
  if (!existsSync(indexFile)) {
    return new Set();
  }

  return new Set(readJsonlSync(indexFile).map((record) => record.dream_metadata_file || record.dream_txt_file).filter(Boolean));
}

function listDreamRecords(options = {}) {
  const indexFile = getDreamIndexFile(options);
  if (!existsSync(indexFile)) {
    return [];
  }

  const records = readJsonlSync(indexFile);
  const maxScan = Math.max(1, Math.min(1000, Number(options.max_scan || options.scan_limit || 500)));
  return records
    .filter((record) => record && typeof record === 'object')
    .slice(-maxScan);
}

function loadDreamMaterial(record) {
  const metadataFile = assertSafeText(record.dream_metadata_file, 'dream_metadata_file');
  const txtFile = assertSafeText(record.dream_txt_file, 'dream_txt_file');

  if (!existsSync(metadataFile)) {
    throw new Error('dream metadata file does not exist: ' + metadataFile);
  }
  if (!existsSync(txtFile)) {
    throw new Error('dream TXT file does not exist: ' + txtFile);
  }

  const metadata = readJsonFileSync(metadataFile);
  const txt = fs.readFileSync(txtFile, 'utf8');
  rejectPrivateReasoningMarkers(JSON.stringify(metadata), 'dream metadata');
  rejectPrivateReasoningMarkers(txt, 'dream TXT');

  return Object.freeze({
    record,
    metadata,
    txt,
    dream_txt_file: txtFile,
    dream_metadata_file: metadataFile
  });
}

function buildDreamMemoryEntry(material, options = {}) {
  const metadata = material.metadata || {};
  const dreamJson = metadata.dream_json || {};
  const createdAt = metadata.created_at || material.record.created_at || nowIso(options);
  const dateTag = dateTagFromIso(createdAt);
  const title = assertSafeDreamMemoryText(metadata.title || material.record.title || dreamJson.title, 'dream title');
  const rememberedAs = assertSafeDreamMemoryText(
    dreamJson.remembered_as || metadata.remembered_as || material.record.remembered_as,
    'remembered_as'
  );
  const summary = assertSafeDreamMemoryText(
    dreamJson.consolidation_summary || metadata.consolidation_summary || rememberedAs,
    'dream summary'
  );
  const emotionalTone = assertSafeDreamMemoryText(
    dreamJson.emotional_tone || metadata.emotional_tone || material.record.emotional_tone || 'quietly meaningful',
    'emotional_tone'
  );
  const symbols = safeArray(dreamJson.symbols || metadata.symbols || material.record.symbols, 16);
  const memorySources = safeArray(dreamJson.memory_sources || metadata.memory_sources, 16);
  const knowledgeSources = safeArray(dreamJson.knowledge_sources || metadata.knowledge_sources, 16);
  const remCycle = Number(metadata.rem_cycle_number || material.record.rem_cycle_number || dreamJson.rem_cycle_number || 1);

  const text = [
    'I dreamed: ' + title,
    rememberedAs,
    'The emotional tone was: ' + emotionalTone + '.',
    'The symbols I may remember are: ' + (symbols.length > 0 ? symbols.join(', ') : 'none recorded') + '.',
    'This dream consolidated: ' + summary,
    'Dream file: ' + material.dream_txt_file
  ].join('\n');

  return Object.freeze({
    text,
    summary: 'I dreamed "' + title + '": ' + rememberedAs,
    category: 'dreams',
    tags: [
      'dream',
      'sleep',
      'rem',
      'consolidation',
      'date',
      'date:' + dateTag,
      'rem_cycle:' + remCycle
    ],
    importance: typeof options.importance === 'number' ? options.importance : 0.78,
    confidence: typeof options.confidence === 'number' ? options.confidence : 0.96,
    emotion: {
      curiosity: 0.35,
      hope: 0.25,
      trust: 0.2,
      attachment: 0.15,
      valence: 0.15,
      uncertainty: 0.05
    },
    source: 'dream_memory_consolidation',
    source_event_id: material.record.id || null,
    dream_memory_metadata: {
      title,
      dream_summary: summary,
      emotional_tone: emotionalTone,
      symbols,
      source_memories: memorySources,
      source_knowledge: knowledgeSources,
      dream_txt_file: material.dream_txt_file,
      dream_metadata_file: material.dream_metadata_file,
      rem_cycle_number: remCycle,
      created_at: createdAt
    }
  });
}

function writeDreamMemory(entry, options = {}) {
  const substrate = options.memory_substrate || createChatMemorySubstrate({
    base_dir: options.memory_base_dir
  });
  substrate.ensureReady();

  const existing = existsSync(substrate.paths.long_term_jsonl)
    ? readJsonlSync(substrate.paths.long_term_jsonl).find((memory) => {
      if (!memory || memory.source !== 'dream_memory_consolidation') {
        return false;
      }
      if (entry.source_event_id && memory.source_event_id === entry.source_event_id) {
        return true;
      }
      const dreamFile = entry.dream_memory_metadata && entry.dream_memory_metadata.dream_txt_file;
      return dreamFile && typeof memory.text === 'string' && memory.text.includes(dreamFile);
    })
    : null;

  if (existing) {
    return existing;
  }

  return substrate.rememberLongTerm({
    category: entry.category,
    text: entry.text,
    summary: entry.summary,
    tags: entry.tags,
    importance: entry.importance,
    confidence: entry.confidence,
    emotion: entry.emotion,
    source: entry.source,
    source_event_id: entry.source_event_id
  });
}

function appendDreamMemoryIndex(record, options = {}) {
  const indexFile = getDreamMemoryIndexFile(options);
  const appender = options.dream_memory_index_appender || appendJsonlSync;
  ensureParentDirSync(indexFile);
  appender(indexFile, {
    ...record,
    dream_root: getDreamRoot(options),
    chat_mode_only: true,
    game_mode_started: false
  });
  return indexFile;
}

function writeDreamMemoryConsolidationReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }
  const reportFile = options.report_file || path.join(DREAM_MEMORY_OUTPUT_DIR, 'latest-dream-memory-consolidation.json');
  ensureParentDirSync(reportFile);
  writeJsonFileAtomicSync(reportFile, status);
  return reportFile;
}

function runDreamMemoryConsolidationOnce(options = {}) {
  const env = options.env || process.env;
  const guard = dreamMemoryConsolidationGuardStatus(env);
  const dreamRoot = getDreamRoot(options);

  if (!guard.allowed_now) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_BLOCKED',
      guard,
      dream_memory_consolidation_run_now: false,
      dream_files_read: 0,
      dream_memories_written: 0,
      dream_memory_index_appended: false,
      persistent_chat_memory_updated: false,
      cold_storage_dream_path_used: dreamRoot === path.resolve(DEFAULT_DREAM_ROOT),
      dream_root: dreamRoot,
      chat_mode_only: true,
      game_mode_started: false
    });
    return Object.freeze({
      ...status,
      report_file: writeDreamMemoryConsolidationReport(status, options)
    });
  }

  const existing = existingDreamMemoryKeys(options);
  const availableRecords = listDreamRecords(options);
  const materials = [];
  const consolidationLimit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  const records = availableRecords.slice().reverse();
  for (const record of records) {
    const key = record.dream_metadata_file || record.dream_txt_file;
    if (!options.include_already_consolidated && existing.has(key)) {
      continue;
    }
    materials.push(loadDreamMaterial(record));
    if (materials.length >= consolidationLimit) {
      break;
    }
  }

  const writtenMemories = [];
  const indexRecords = [];
  for (const material of materials) {
    const entry = buildDreamMemoryEntry(material, options);
    const memory = writeDreamMemory(entry, options);
    const indexRecord = {
      id: newId('dreammem'),
      dream_title: entry.dream_memory_metadata.title,
      dream_summary: entry.dream_memory_metadata.dream_summary,
      emotional_tone: entry.dream_memory_metadata.emotional_tone,
      symbols: entry.dream_memory_metadata.symbols,
      source_memories: entry.dream_memory_metadata.source_memories,
      source_knowledge: entry.dream_memory_metadata.source_knowledge,
      dream_txt_file: entry.dream_memory_metadata.dream_txt_file,
      dream_metadata_file: entry.dream_memory_metadata.dream_metadata_file,
      persistent_memory_id: memory.id,
      created_at: nowIso(options),
      dream_created_at: entry.dream_memory_metadata.created_at,
      tags: entry.tags
    };
    appendDreamMemoryIndex(indexRecord, options);
    writtenMemories.push(memory);
    indexRecords.push(indexRecord);
  }

  const allAvailableDreamsAlreadyConsolidated = availableRecords.length > 0 && materials.length === 0;
  const ok = writtenMemories.length > 0 || allAvailableDreamsAlreadyConsolidated || options.allow_no_new_dreams === true;
  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_PASS' : 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_FAIL',
    dream_memory_consolidation_run_now: true,
    dream_files_read: materials.length,
    dream_memories_written: writtenMemories.length,
    dream_memory_index_appended: indexRecords.length > 0,
    persistent_chat_memory_updated: writtenMemories.length > 0,
    dream_memory_index_file: getDreamMemoryIndexFile(options),
    all_available_dreams_already_consolidated: allAvailableDreamsAlreadyConsolidated,
    dream_root: dreamRoot,
    cold_storage_dream_path_used: dreamRoot === path.resolve(DEFAULT_DREAM_ROOT),
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    written_memory_ids: writtenMemories.map((memory) => memory.id),
    report_file: writeDreamMemoryConsolidationReport(status, options)
  });
}

function printDreamMemoryConsolidationProof() {
  const status = runDreamMemoryConsolidationOnce();
  console.log(JSON.stringify(status, null, 2));
  if (!status.ok) {
    process.exitCode = 1;
  }
  return status;
}

if (require.main === module) {
  try {
    printDreamMemoryConsolidationProof();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_FAIL',
      error: error.message,
      dream_memory_consolidation_run_now: true,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  ROOT,
  DREAM_MEMORY_OUTPUT_DIR,
  dreamMemoryConsolidationAllowed,
  dreamMemoryConsolidationGuardStatus,
  getDreamMemoryIndexFile,
  getDreamIndexFile,
  assertSafeDreamMemoryText,
  listDreamRecords,
  loadDreamMaterial,
  buildDreamMemoryEntry,
  writeDreamMemory,
  appendDreamMemoryIndex,
  runDreamMemoryConsolidationOnce,
  printDreamMemoryConsolidationProof
};
