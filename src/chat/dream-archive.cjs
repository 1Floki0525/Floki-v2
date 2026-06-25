'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDreamRoot } = require('./dream-engine.cjs');

function canonical(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  try { return fs.realpathSync.native(resolved); } catch (_error) { return resolved; }
}

function inside(root, file) {
  const relative = path.relative(canonical(root), canonical(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return null; }
}

function readJsonl(file) {
  const records = [];
  let malformed = 0;
  if (!fs.existsSync(file)) return { records, malformed };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      else malformed += 1;
    } catch (_error) {
      malformed += 1;
    }
  }
  return { records, malformed };
}

function walkMetadata(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        !['dream-index.json', 'dream-memory-index.json'].includes(entry.name)
      ) output.push(file);
    }
  }
  return output.sort();
}

function nestedDream(metadata) {
  if (metadata && metadata.dream_json && typeof metadata.dream_json === 'object') return metadata.dream_json;
  if (metadata && metadata.model_dream_json && typeof metadata.model_dream_json === 'object') return metadata.model_dream_json;
  return metadata || {};
}

function stableDreamId(metadataFile, textFile, metadata) {
  if (metadata && (metadata.dream_id || metadata.id)) return String(metadata.dream_id || metadata.id).trim();
  return 'dream_' + crypto.createHash('sha256')
    .update(canonical(metadataFile) + '\0' + canonical(textFile))
    .digest('hex')
    .slice(0, 24);
}

function resolveTextFile(metadataFile, metadata, dream) {
  const declared = metadata.dream_txt_file || dream.dream_txt_file || null;
  const candidates = [];
  if (declared) {
    candidates.push(path.isAbsolute(declared) ? declared : path.resolve(path.dirname(metadataFile), declared));
  }
  candidates.push(metadataFile.replace(/\.json$/i, '.txt'));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function candidateFromMetadata(metadataFile, root) {
  const metadata = safeJson(metadataFile);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { ok: false, malformed: true, reason: 'invalid_json', metadata_file: metadataFile };
  }
  const dream = nestedDream(metadata);
  const title = String(metadata.title || dream.title || '').trim();
  const createdAt = String(metadata.created_at || dream.created_at || '').trim();
  const textFile = resolveTextFile(metadataFile, metadata, dream);
  if (!title || !createdAt || !textFile) {
    return { ok: false, malformed: true, reason: 'missing_title_created_at_or_text', metadata_file: metadataFile };
  }
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) {
    return { ok: false, malformed: true, reason: 'invalid_created_at', metadata_file: metadataFile };
  }
  const canonicalMetadata = canonical(metadataFile);
  const canonicalText = canonical(textFile);
  if (!inside(root, canonicalMetadata) || !inside(root, canonicalText)) {
    return { ok: false, malformed: true, reason: 'path_outside_dream_root', metadata_file: metadataFile };
  }
  return {
    ok: true,
    record: {
      dream_id: stableDreamId(canonicalMetadata, canonicalText, metadata),
      title,
      created_at: new Date(time).toISOString(),
      rem_cycle_number: Number(metadata.rem_cycle_number || dream.rem_cycle_number || 1) || 1,
      sleep_kind: metadata.sleep_kind || dream.sleep_kind || 'historical',
      dream_txt_file: canonicalText,
      dream_metadata_file: canonicalMetadata,
      remembered_as: metadata.remembered_as || dream.remembered_as || null,
      emotional_tone: metadata.emotional_tone || dream.emotional_tone || null,
      symbols: Array.isArray(metadata.symbols) ? metadata.symbols : Array.isArray(dream.symbols) ? dream.symbols : [],
      dream_root: canonical(root),
      archive_reconciled: true,
      chat_mode_only: true,
      game_mode_started: false
    }
  };
}

function recordKeys(record) {
  return [
    record && record.dream_id ? 'id:' + String(record.dream_id) : null,
    record && record.dream_metadata_file ? 'meta:' + canonical(record.dream_metadata_file) : null,
    record && record.dream_txt_file ? 'txt:' + canonical(record.dream_txt_file) : null
  ].filter(Boolean);
}

function writeIndexAtomic(indexFile, records) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const temp = indexFile + '.tmp-' + process.pid;
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(temp, body ? body + '\n' : '', 'utf8');
  fs.renameSync(temp, indexFile);
}

function reconcileDreamArchive(options = {}) {
  const root = canonical(options.dream_root || getDreamRoot(options));
  const indexFile = canonical(options.index_file || path.join(root, 'dream-index.jsonl'));
  fs.mkdirSync(root, { recursive: true });

  const loaded = readJsonl(indexFile);
  const records = [];
  const known = new Set();
  let alreadyIndexed = 0;
  let skipped = 0;
  let malformed = loaded.malformed;
  let duplicates = 0;

  for (const indexed of loaded.records) {
    const metadataFile = indexed.dream_metadata_file && canonical(indexed.dream_metadata_file);
    if (!metadataFile || !fs.existsSync(metadataFile)) {
      skipped += 1;
      continue;
    }
    const parsed = candidateFromMetadata(metadataFile, root);
    if (!parsed.ok) {
      malformed += 1;
      continue;
    }
    const keys = recordKeys(parsed.record);
    if (keys.some((key) => known.has(key))) {
      duplicates += 1;
      continue;
    }
    keys.forEach((key) => known.add(key));
    records.push(parsed.record);
    alreadyIndexed += 1;
  }

  const metadataFiles = walkMetadata(root);
  let indexed = 0;
  for (const metadataFile of metadataFiles) {
    const parsed = candidateFromMetadata(metadataFile, root);
    if (!parsed.ok) {
      malformed += 1;
      continue;
    }
    const keys = recordKeys(parsed.record);
    if (keys.some((key) => known.has(key))) continue;
    keys.forEach((key) => known.add(key));
    records.push(parsed.record);
    indexed += 1;
  }

  records.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  const rewriteNeeded = indexed > 0 || malformed > 0 || skipped > 0 || duplicates > 0 || loaded.records.length !== records.length;
  if (rewriteNeeded || !fs.existsSync(indexFile)) writeIndexAtomic(indexFile, records);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ARCHIVE_RECONCILIATION_PASS',
    dream_root: root,
    dream_index_file: indexFile,
    discovered: metadataFiles.length,
    indexed,
    already_indexed: alreadyIndexed,
    skipped,
    malformed,
    duplicates,
    archive_count: records.length,
    records: Object.freeze(records.map((record) => Object.freeze({ ...record })))
  });
}

if (require.main === module) console.log(JSON.stringify(reconcileDreamArchive(), null, 2));
module.exports = { reconcileDreamArchive, candidateFromMetadata, stableDreamId };
