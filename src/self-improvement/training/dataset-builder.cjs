'use strict';

// Training dataset builder for the RSI QLoRA pipeline.
//
// Builds an attributable dataset from bounded, approved local sources. Every
// record carries full provenance (source type/path/hash, created time, approval,
// purpose, identity relevance, confidence). Records are deduplicated and bounded
// by YAML min/max lengths and counts. Writes an immutable records file plus a
// manifest with a SHA-256 over the records. Secrets are never ingested.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadSelfImprovementConfig } = require('../config.cjs');

// Paths/segments that must never be ingested as training data.
const SECRET_PATTERNS = [
  /\.env(\.|$)/i,
  /cookies?\.txt$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /secrets?\//i,
  /token/i
];

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function parseSources(value) {
  const out = [];
  for (const pair of splitPipeList(value)) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    out.push({ type: pair.slice(0, idx).trim(), rel: pair.slice(idx + 1).trim() });
  }
  return out;
}

function isSecretPath(p) {
  return SECRET_PATTERNS.some((re) => re.test(p));
}

function hashString(text, algorithm) {
  return crypto.createHash(algorithm).update(text).digest('hex');
}

function newDatasetId(config) {
  return config.dataset_id_prefix + '-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
}

function chunkText(text, minChars, maxChars) {
  const chunks = [];
  const paragraphs = String(text).split(/\n\s*\n/);
  let buffer = '';
  for (const para of paragraphs) {
    const piece = para.trim();
    if (!piece) continue;
    if ((buffer + '\n\n' + piece).length > maxChars) {
      if (buffer) chunks.push(buffer);
      if (piece.length > maxChars) {
        for (let i = 0; i < piece.length; i += maxChars) chunks.push(piece.slice(i, i + maxChars));
        buffer = '';
      } else {
        buffer = piece;
      }
    } else {
      buffer = buffer ? buffer + '\n\n' + piece : piece;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.filter((c) => c.length >= minChars);
}

function collectRecordsFromFile(absFile, relLabel, sourceType, config) {
  if (isSecretPath(absFile)) return [];
  let content;
  try {
    content = fs.readFileSync(absFile, 'utf8');
  } catch {
    return [];
  }
  const created = (() => {
    try { return fs.statSync(absFile).mtime.toISOString(); } catch { return new Date().toISOString(); }
  })();
  const chunks = chunkText(content, config.dataset_min_record_chars, config.dataset_max_record_chars);
  return chunks.map((text) => ({
    text,
    source_type: sourceType,
    source_path: relLabel,
    source_hash: hashString(text, config.dataset_hash_algorithm),
    created_at: created,
    approval_status: 'approved',
    training_purpose: sourceType === 'soul' ? 'identity_continuity' : 'engineering_reasoning',
    identity_relevance: sourceType === 'soul' ? 'high' : 'medium',
    confidence: 0.8
  }));
}

function collectFromSource(source, config) {
  const abs = path.isAbsolute(source.rel) ? source.rel : path.resolve(config.project_root, source.rel);
  if (isSecretPath(abs)) {
    throw new Error('refusing to ingest a secret-like source: ' + source.rel);
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return collectRecordsFromFile(abs, source.rel, source.type, config);
  if (stat.isDirectory()) {
    const records = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (isSecretPath(child)) continue;
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (entry.isFile() && /\.(md|json|jsonl|txt)$/i.test(entry.name)) {
          records.push(...collectRecordsFromFile(child, path.relative(config.project_root, child), source.type, config));
        }
      }
    };
    walk(abs, 0);
    return records;
  }
  return [];
}

function buildDataset(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const sources = options.sources ? parseSources(options.sources) : parseSources(config.dataset_sources);

  let records = [];
  for (const source of sources) {
    records.push(...collectFromSource(source, config));
  }

  // Deduplicate by record hash.
  const seen = new Set();
  records = records.filter((r) => {
    if (seen.has(r.source_hash)) return false;
    seen.add(r.source_hash);
    return true;
  });

  // Enforce length bounds (defensive; chunker already applies min).
  records = records.filter(
    (r) => r.text.length >= config.dataset_min_record_chars && r.text.length <= config.dataset_max_record_chars
  );

  if (records.length < config.dataset_min_records) {
    throw new Error('dataset has too few records: ' + records.length + ' < ' + config.dataset_min_records);
  }
  if (records.length > config.dataset_max_records) {
    records = records.slice(0, config.dataset_max_records);
  }

  const datasetId = options.datasetId || newDatasetId(config);
  const root = path.join(config.dataset_root, datasetId);
  fs.mkdirSync(root, { recursive: true });

  const recordsFile = path.join(root, config.dataset_records_file_name);
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(recordsFile, jsonl, 'utf8');
  const recordsHash = hashString(jsonl, config.dataset_hash_algorithm);

  const manifest = {
    marker: 'FLOKI_V2_RSI_DATASET_MANIFEST',
    schema_version: 1,
    dataset_id: datasetId,
    created_at: new Date().toISOString(),
    hash_algorithm: config.dataset_hash_algorithm,
    records_file: config.dataset_records_file_name,
    records_sha256: recordsHash,
    record_count: records.length,
    sources: sources.map((s) => ({ type: s.type, path: s.rel })),
    provenance_fields: ['source_type', 'source_path', 'source_hash', 'created_at', 'approval_status', 'training_purpose', 'identity_relevance', 'confidence'],
    min_record_chars: config.dataset_min_record_chars,
    max_record_chars: config.dataset_max_record_chars
  };
  const manifestFile = path.join(root, config.dataset_manifest_file_name);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return Object.freeze({ ...manifest, root, records_path: recordsFile, manifest_path: manifestFile });
}

module.exports = {
  buildDataset,
  parseSources,
  isSecretPath,
  chunkText,
  hashString,
  SECRET_PATTERNS
};
