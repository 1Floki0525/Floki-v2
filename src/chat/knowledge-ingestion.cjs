'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  statePath,
  ensureDirSync,
  ensureParentDirSync,
  existsSync,
  readJsonFileSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const {
  appendJsonlSync,
  readJsonlSync
} = require('../util/jsonl.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const FLOKI_MEDIA_ROOT = '/media/binary-god/2tb-ssd/Floki-media';
const KNOWLEDGE_INGESTION_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'knowledge-ingestion');

const SUPPORTED_TEXT_EXTENSIONS = Object.freeze([
  '.txt',
  '.md',
  '.json',
  '.jsonl',
  '.srt',
  '.vtt',
  '.log',
  '.csv'
]);

function knowledgeIngestionAllowed(env = process.env) {
  return env.FLOKI_ALLOW_KNOWLEDGE_INGESTION === '1';
}

function knowledgeIngestionGuardStatus(env = process.env) {
  const allowed = knowledgeIngestionAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_KNOWLEDGE_INGESTION=1',
    knowledge_ingestion_run_now: false,
    source_files_read: 0,
    chunks_written: 0,
    sources_written: 0,
    index_written: false,
    memory_write_now: false,
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false,
    reason: allowed
      ? 'Knowledge ingestion is explicitly allowed for this run.'
      : 'Knowledge ingestion is guarded and will not read sources or write chunks without FLOKI_ALLOW_KNOWLEDGE_INGESTION=1.'
  });
}

function nowIso(options = {}) {
  if (typeof options.clock === 'function') {
    return new Date(options.clock()).toISOString();
  }

  if (options.now) {
    return new Date(options.now).toISOString();
  }

  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function getKnowledgeRoot(options = {}) {
  const env = options.env || process.env;

  return path.resolve(
    options.knowledge_root ||
    env.FLOKI_KNOWLEDGE_ROOT ||
    statePath('chat/knowledge')
  );
}

function getKnowledgePaths(options = {}) {
  const root = getKnowledgeRoot(options);

  return Object.freeze({
    root,
    chunks_jsonl: path.join(root, 'chunks.jsonl'),
    sources_jsonl: path.join(root, 'sources.jsonl'),
    index_json: path.join(root, 'index.json'),
    ingestion_events_jsonl: path.join(root, 'ingestion-events.jsonl')
  });
}

function supportedExtension(filePath) {
  return SUPPORTED_TEXT_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function normalizePath(filePath) {
  return path.resolve(String(filePath || ''));
}

function escapeRegExp(value) {
  const specials = '\\^$.*+?()[]{}|';
  let out = '';

  for (const ch of String(value || '')) {
    out += specials.includes(ch) ? '\\' + ch : ch;
  }

  return out;
}

function channelFolderFromPath(inputPath) {
  const normalized = normalizePath(inputPath);
  const parts = normalized.split(path.sep);
  const youtubeIndex = parts.lastIndexOf('youtube');

  if (youtubeIndex >= 0 && parts[youtubeIndex + 1]) {
    return parts[youtubeIndex + 1];
  }

  return path.basename(normalized);
}

function detectKnowledgeInput(inputPath, options = {}) {
  const absolutePath = normalizePath(inputPath);

  if (!existsSync(absolutePath)) {
    return Object.freeze({
      ok: false,
      input_path: absolutePath,
      input_type: 'missing',
      supported: false,
      reason: 'input path does not exist',
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  const stat = fs.statSync(absolutePath);

  if (stat.isFile()) {
    const supported = supportedExtension(absolutePath);

    return Object.freeze({
      ok: supported,
      input_path: absolutePath,
      input_type: supported ? 'text_file' : 'unsupported_file',
      supported,
      extension: path.extname(absolutePath).toLowerCase(),
      reason: supported ? 'supported text file' : 'unsupported file extension',
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  if (stat.isDirectory()) {
    const manifest = path.join(absolutePath, 'transcripts.manifest.jsonl');
    const report = path.join(absolutePath, 'SCRAPE_REPORT.latest.json');
    const normalized = absolutePath.split(path.sep).join('/');
    const looksLikeYoutube = normalized.includes('/text/youtube/') ||
      existsSync(manifest) ||
      existsSync(report);

    return Object.freeze({
      ok: true,
      input_path: absolutePath,
      input_type: looksLikeYoutube ? 'youtube_transcript_dir' : 'directory',
      supported: true,
      channel_folder: looksLikeYoutube ? channelFolderFromPath(absolutePath) : null,
      manifest_file: existsSync(manifest) ? manifest : null,
      scrape_report_file: existsSync(report) ? report : null,
      reason: looksLikeYoutube ? 'youtube transcript folder' : 'directory of supported text files',
      chat_mode_only: true,
      game_mode_started: false
    });
  }

  return Object.freeze({
    ok: false,
    input_path: absolutePath,
    input_type: 'unsupported_path',
    supported: false,
    reason: 'input path is not a file or directory',
    chat_mode_only: true,
    game_mode_started: false
  });
}

function walkFiles(directoryPath, options = {}) {
  const out = [];
  const maxFiles = Math.max(1, Math.min(5000, Number(options.max_files || 1000)));

  function visit(currentPath) {
    if (out.length >= maxFiles) {
      return;
    }

    const stat = fs.lstatSync(currentPath);

    if (stat.isSymbolicLink()) {
      return;
    }

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(currentPath)
        .filter((name) => !name.startsWith('.'))
        .sort();

      for (const entry of entries) {
        visit(path.join(currentPath, entry));

        if (out.length >= maxFiles) {
          return;
        }
      }

      return;
    }

    if (stat.isFile()) {
      out.push(currentPath);
    }
  }

  visit(directoryPath);
  return out;
}

function listIngestibleFiles(inputPath, options = {}) {
  const detected = options.detected || detectKnowledgeInput(inputPath, options);

  if (!detected.ok) {
    return Object.freeze({
      input: detected,
      supported_files: [],
      unsupported_files: []
    });
  }

  const files = detected.input_type === 'text_file'
    ? [detected.input_path]
    : walkFiles(detected.input_path, options);

  const supported = [];
  const unsupported = [];

  for (const filePath of files) {
    const base = path.basename(filePath);

    if (base === 'SCRAPE_REPORT.latest.json' || base === 'transcripts.manifest.jsonl') {
      supported.push(filePath);
      continue;
    }

    if (supportedExtension(filePath)) {
      supported.push(filePath);
    } else {
      unsupported.push(filePath);
    }
  }

  return Object.freeze({
    input: detected,
    supported_files: supported.sort(),
    unsupported_files: unsupported.sort()
  });
}

function stripSubtitleNoise(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^WEBVTT/i.test(line)) return false;
      if (/^NOTE\b/i.test(line)) return false;
      if (/^STYLE\b/i.test(line)) return false;
      if (/^Kind:/i.test(line)) return false;
      if (/^Language:/i.test(line)) return false;
      if (/^\d+$/.test(line)) return false;
      if (/-->/i.test(line)) return false;
      return true;
    })
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function parseManifestRecords(manifestFile) {
  if (!manifestFile || !existsSync(manifestFile)) {
    return [];
  }

  try {
    return readJsonlSync(manifestFile);
  } catch (error) {
    return [];
  }
}

function readJsonSafe(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    return readJsonFileSync(filePath);
  } catch (error) {
    return null;
  }
}

function extractVideoIdFromFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^\d{8}_([^_]+)_/);

  if (match) {
    return match[1];
  }

  return null;
}

function titleFromFilename(filePath, videoId) {
  let base = path.basename(filePath);
  base = base.replace(/\.[^.]+$/, '');
  base = base.replace(/\.(en|en-us|en-gb|en-auto|en-orig)$/i, '');

  if (videoId) {
    const prefix = new RegExp('^\\d{8}_' + escapeRegExp(videoId) + '_');
    base = base.replace(prefix, '');
  }

  return base.replace(/[_-]+/g, ' ').trim() || path.basename(filePath);
}

function manifestRecordForFile(filePath, manifestRecords) {
  const videoId = extractVideoIdFromFilename(filePath);
  const absolute = normalizePath(filePath);

  return (Array.isArray(manifestRecords) ? manifestRecords : []).find((record) => {
    if (!record || typeof record !== 'object') {
      return false;
    }

    if (videoId && record.video_id === videoId) {
      return true;
    }

    if (record.text_file && normalizePath(record.text_file) === absolute) {
      return true;
    }

    return false;
  }) || null;
}

function readKnowledgeSource(filePath, options = {}) {
  const absolutePath = normalizePath(filePath);
  const ext = path.extname(absolutePath).toLowerCase();

  if (!supportedExtension(absolutePath)) {
    throw new Error('unsupported file extension for knowledge source: ' + ext);
  }

  let text = fs.readFileSync(absolutePath, 'utf8');

  if (ext === '.vtt' || ext === '.srt') {
    text = stripSubtitleNoise(text);
  }

  const sourceSha = sha256(text);
  const manifestRecords = Array.isArray(options.manifest_records) ? options.manifest_records : [];
  const manifestRecord = manifestRecordForFile(absolutePath, manifestRecords);
  const videoId = manifestRecord && manifestRecord.video_id
    ? manifestRecord.video_id
    : extractVideoIdFromFilename(absolutePath);
  const title = manifestRecord && (manifestRecord.title_guess || manifestRecord.title)
    ? String(manifestRecord.title_guess || manifestRecord.title)
    : titleFromFilename(absolutePath, videoId);

  const inputType = options.input_type || 'text_file';
  const sourceType = inputType === 'youtube_transcript_dir'
    ? (path.basename(absolutePath) === 'transcripts.manifest.jsonl' ? 'transcript_manifest' : 'youtube_transcript')
    : 'text_file';

  return Object.freeze({
    source_id: sha256(absolutePath + '\n' + sourceSha).slice(0, 24),
    source_path: absolutePath,
    source_type: sourceType,
    extension: ext,
    title,
    text,
    text_sha256: sourceSha,
    char_count: text.length,
    word_count: text.split(/\s+/).filter(Boolean).length,
    channel_folder: options.channel_folder || null,
    video_id: videoId || null,
    manifest_record: manifestRecord || null,
    created_at: nowIso(options),
    chat_mode_only: true,
    game_mode_started: false
  });
}

function splitLargeText(text, maxChars) {
  const chunks = [];
  let offset = 0;

  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxChars));
    offset += maxChars;
  }

  return chunks;
}

function chunkKnowledgeText(source, options = {}) {
  const targetChars = Math.max(800, Math.min(5000, Number(options.target_chars || 1800)));
  const maxChars = Math.max(targetChars, Math.min(6000, Number(options.max_chars || 2500)));
  const minChars = Math.max(200, Math.min(targetChars, Number(options.min_chars || 1200)));
  const text = String(source.text || '').trim();

  if (!text) {
    return [];
  }

  const paragraphs = text.split(/\n{2,}|\r?\n/).map((item) => item.trim()).filter(Boolean);
  const rawChunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current.trim()) {
        rawChunks.push(current.trim());
        current = '';
      }

      rawChunks.push.apply(rawChunks, splitLargeText(paragraph, maxChars).map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current.length + 2 + paragraph.length) <= targetChars) {
      current += '\n\n' + paragraph;
      continue;
    }

    if (current.length >= minChars || (current.length + 2 + paragraph.length) > maxChars) {
      rawChunks.push(current.trim());
      current = paragraph;
    } else {
      current += '\n\n' + paragraph;
    }
  }

  if (current.trim()) {
    rawChunks.push(current.trim());
  }

  return rawChunks.map((chunkText, index) => {
    const chunkSha = sha256(chunkText);

    return Object.freeze({
      chunk_id: sha256(source.source_id + ':' + index + ':' + chunkSha).slice(0, 32),
      source_id: source.source_id,
      source_path: source.source_path,
      source_type: source.source_type,
      title: source.title,
      channel_folder: source.channel_folder,
      video_id: source.video_id,
      chunk_index: index,
      text: chunkText,
      text_sha256: chunkSha,
      source_text_sha256: source.text_sha256,
      char_count: chunkText.length,
      word_count: chunkText.split(/\s+/).filter(Boolean).length,
      created_at: nowIso(options),
      chat_mode_only: true,
      game_mode_started: false
    });
  });
}

function loadExistingChunkHashes(options = {}) {
  const paths = getKnowledgePaths(options);

  if (!existsSync(paths.chunks_jsonl)) {
    return new Set();
  }

  return new Set(readJsonlSync(paths.chunks_jsonl).map((record) => record && record.text_sha256).filter(Boolean));
}

function writeKnowledgeIndex(paths, options = {}) {
  const chunks = existsSync(paths.chunks_jsonl) ? readJsonlSync(paths.chunks_jsonl) : [];
  const sources = existsSync(paths.sources_jsonl) ? readJsonlSync(paths.sources_jsonl) : [];
  const index = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_INDEX_READY',
    knowledge_root: paths.root,
    chunk_count_total: chunks.length,
    source_count_total: sources.length,
    updated_at: nowIso(options),
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false
  });

  writeJsonFileAtomicSync(paths.index_json, index);
  return index;
}

function persistKnowledgeChunks(chunks, source, options = {}) {
  const paths = getKnowledgePaths(options);
  ensureDirSync(paths.root);

  const existingHashes = options.existing_hashes || loadExistingChunkHashes(options);
  const persisted = [];
  let duplicateCount = 0;

  const sourceRecord = Object.freeze({
    source_id: source.source_id,
    source_path: source.source_path,
    source_type: source.source_type,
    extension: source.extension,
    title: source.title,
    channel_folder: source.channel_folder,
    video_id: source.video_id,
    text_sha256: source.text_sha256,
    char_count: source.char_count,
    word_count: source.word_count,
    created_at: nowIso(options),
    chat_mode_only: true,
    game_mode_started: false
  });

  appendJsonlSync(paths.sources_jsonl, sourceRecord);

  for (const chunk of chunks) {
    if (existingHashes.has(chunk.text_sha256)) {
      duplicateCount += 1;
      continue;
    }

    appendJsonlSync(paths.chunks_jsonl, chunk);
    existingHashes.add(chunk.text_sha256);
    persisted.push(chunk);
  }

  const index = writeKnowledgeIndex(paths, options);

  appendJsonlSync(paths.ingestion_events_jsonl, {
    event_type: 'knowledge_source_ingested',
    source_id: source.source_id,
    source_path: source.source_path,
    source_type: source.source_type,
    chunks_written: persisted.length,
    duplicate_chunk_count: duplicateCount,
    created_at: nowIso(options),
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    source_record: sourceRecord,
    chunks_written: persisted.length,
    duplicate_chunk_count: duplicateCount,
    persisted_chunks: persisted,
    index
  });
}

function writeKnowledgeIngestionReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const reportFile = options.report_file || path.join(KNOWLEDGE_INGESTION_OUTPUT_DIR, 'latest-knowledge-ingestion.json');
  ensureParentDirSync(reportFile);
  writeJsonFileAtomicSync(reportFile, status);
  return reportFile;
}

function blockedStatus(options = {}) {
  const guard = knowledgeIngestionGuardStatus(options.env || process.env);

  return Object.freeze({
    ok: false,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_BLOCKED',
    guard,
    input_path: options.input_path || null,
    input_type: null,
    source_count: 0,
    chunk_count: 0,
    duplicate_chunk_count: 0,
    unsupported_count: 0,
    failed_count: 0,
    total_chars: 0,
    total_words: 0,
    persistent_knowledge_used: false,
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false,
    report_file: null
  });
}

function runKnowledgeIngestionOnce(options = {}) {
  const env = options.env || process.env;
  const guard = knowledgeIngestionGuardStatus(env);

  if (!guard.allowed_now) {
    return blockedStatus(options);
  }

  const inputPath = options.input_path || env.FLOKI_KNOWLEDGE_INPUT_PATH;

  if (!inputPath) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_FAIL',
      reason: 'input_path is required',
      input_path: null,
      input_type: null,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unsupported_count: 0,
      failed_count: 1,
      total_chars: 0,
      total_words: 0,
      persistent_knowledge_used: false,
      model_called_now: false,
      network_called_now: false,
      chat_mode_only: true,
      game_mode_started: false
    });

    return Object.freeze({
      ...status,
      report_file: writeKnowledgeIngestionReport(status, options)
    });
  }

  const detected = detectKnowledgeInput(inputPath, options);

  if (!detected.ok) {
    const status = Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_FAIL',
      reason: detected.reason,
      input_path: detected.input_path,
      input_type: detected.input_type,
      source_count: 0,
      chunk_count: 0,
      duplicate_chunk_count: 0,
      unsupported_count: 0,
      failed_count: 1,
      total_chars: 0,
      total_words: 0,
      persistent_knowledge_used: false,
      model_called_now: false,
      network_called_now: false,
      chat_mode_only: true,
      game_mode_started: false
    });

    return Object.freeze({
      ...status,
      report_file: writeKnowledgeIngestionReport(status, options)
    });
  }

  const listed = listIngestibleFiles(detected.input_path, {
    ...options,
    detected
  });
  const manifestRecords = parseManifestRecords(detected.manifest_file);
  const scrapeReport = readJsonSafe(detected.scrape_report_file);
  const existingHashes = loadExistingChunkHashes(options);

  let sourceCount = 0;
  let chunkCount = 0;
  let duplicateChunkCount = 0;
  let failedCount = 0;
  let totalChars = 0;
  let totalWords = 0;
  const sourceSummaries = [];

  for (const filePath of listed.supported_files) {
    try {
      const source = readKnowledgeSource(filePath, {
        ...options,
        input_type: detected.input_type,
        channel_folder: detected.channel_folder,
        manifest_records: manifestRecords,
        scrape_report: scrapeReport
      });

      if (!source.text.trim()) {
        continue;
      }

      const chunks = chunkKnowledgeText(source, options);
      const persisted = persistKnowledgeChunks(chunks, source, {
        ...options,
        existing_hashes: existingHashes
      });

      sourceCount += 1;
      chunkCount += persisted.chunks_written;
      duplicateChunkCount += persisted.duplicate_chunk_count;
      totalChars += source.char_count;
      totalWords += source.word_count;
      sourceSummaries.push({
        source_path: source.source_path,
        source_type: source.source_type,
        title: source.title,
        channel_folder: source.channel_folder,
        video_id: source.video_id,
        chunks_written: persisted.chunks_written,
        duplicate_chunk_count: persisted.duplicate_chunk_count
      });
    } catch (error) {
      failedCount += 1;
    }
  }

  const ok = failedCount === 0 && (sourceCount > 0 || listed.unsupported_files.length > 0);
  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_KNOWLEDGE_INGESTION_CONTRACT_PASS' : 'FLOKI_V2_KNOWLEDGE_INGESTION_FAIL',
    input_path: detected.input_path,
    input_type: detected.input_type,
    channel_folder: detected.channel_folder || null,
    source_count: sourceCount,
    chunk_count: chunkCount,
    duplicate_chunk_count: duplicateChunkCount,
    unsupported_count: listed.unsupported_files.length,
    failed_count: failedCount,
    total_chars: totalChars,
    total_words: totalWords,
    persistent_knowledge_used: true,
    knowledge_root: getKnowledgeRoot(options),
    knowledge_paths: getKnowledgePaths(options),
    source_summaries: sourceSummaries,
    unsupported_files: listed.unsupported_files,
    model_called_now: false,
    network_called_now: false,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: writeKnowledgeIngestionReport(status, options)
  });
}

function printKnowledgeIngestionProof() {
  const status = runKnowledgeIngestionOnce();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  try {
    printKnowledgeIngestionProof();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_FAIL',
      error: error.message,
      model_called_now: false,
      network_called_now: false,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  ROOT,
  FLOKI_MEDIA_ROOT,
  KNOWLEDGE_INGESTION_OUTPUT_DIR,
  SUPPORTED_TEXT_EXTENSIONS,
  knowledgeIngestionAllowed,
  knowledgeIngestionGuardStatus,
  getKnowledgeRoot,
  getKnowledgePaths,
  detectKnowledgeInput,
  listIngestibleFiles,
  readKnowledgeSource,
  chunkKnowledgeText,
  loadExistingChunkHashes,
  persistKnowledgeChunks,
  runKnowledgeIngestionOnce,
  printKnowledgeIngestionProof
};
