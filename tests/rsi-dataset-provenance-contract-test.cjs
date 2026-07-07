'use strict';

// Contract: the dataset builder produces attributable, deduplicated, bounded
// records with full provenance, writes an immutable records file + manifest with
// a SHA-256, enforces min/max counts, and refuses secret sources. Real functions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('../src/self-improvement/training/dataset-builder.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const base = loadSelfImprovementConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-ds-'));

function para(n, label) {
  // produce a >= min-char paragraph
  return (label + ' ').repeat(20).trim() + ' #' + n;
}

try {
  // synthetic sources
  const soulFile = path.join(tmp, 'SOUL.md');
  fs.writeFileSync(soulFile, [para(1, 'identity'), para(2, 'values'), para(3, 'continuity')].join('\n\n'));
  const engDir = path.join(tmp, 'candidates');
  fs.mkdirSync(engDir, { recursive: true });
  fs.writeFileSync(path.join(engDir, 'a.md'), [para(4, 'engineering lesson'), para(5, 'repair pattern')].join('\n\n'));
  fs.writeFileSync(path.join(engDir, 'b.md'), [para(6, 'tool use lesson'), para(7, 'config transport')].join('\n\n'));
  // a duplicate paragraph to verify dedup
  fs.writeFileSync(path.join(engDir, 'c.md'), para(1, 'identity'));

  const config = Object.assign({}, base, {
    dataset_root: path.join(tmp, 'datasets'),
    dataset_min_records: 3,
    dataset_max_records: 100,
    dataset_min_record_chars: 20,
    dataset_max_record_chars: 256
  });
  const sources = 'soul=' + soulFile + '|engineering_candidates=' + engDir;

  const manifest = db.buildDataset({ config, sources });
  assert.equal(manifest.marker, 'FLOKI_V2_RSI_DATASET_MANIFEST');
  assert.ok(manifest.record_count >= config.dataset_min_records, 'min records enforced');

  // records file exists, hash matches manifest
  assert.ok(fs.existsSync(manifest.records_path), 'records file written');
  const jsonl = fs.readFileSync(manifest.records_path, 'utf8');
  const recomputed = crypto.createHash('sha256').update(jsonl).digest('hex');
  assert.equal(recomputed, manifest.records_sha256, 'manifest sha256 matches records');

  // every record carries full provenance
  const records = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  for (const r of records) {
    for (const field of ['source_type', 'source_path', 'source_hash', 'created_at', 'approval_status', 'training_purpose', 'identity_relevance', 'confidence']) {
      assert.ok(field in r, 'record has provenance field ' + field);
    }
    assert.ok(r.text.length >= config.dataset_min_record_chars && r.text.length <= config.dataset_max_record_chars, 'record length bounded');
  }

  // dedup: the duplicated 'identity #1' paragraph appears once
  const identityCount = records.filter((r) => r.text.includes('identity') && r.text.includes('#1')).length;
  assert.equal(identityCount, 1, 'duplicate record removed');

  // too-few-records throws
  assert.throws(
    () => db.buildDataset({ config: Object.assign({}, config, { dataset_min_records: 9999 }), sources }),
    /too few records/
  );

  // secret source refused
  const secretFile = path.join(tmp, 'cookies.txt');
  fs.writeFileSync(secretFile, 'secret');
  assert.throws(
    () => db.buildDataset({ config, sources: 'leak=' + secretFile }),
    /secret-like source/
  );
  assert.equal(db.isSecretPath('/x/.env'), true);
  assert.equal(db.isSecretPath('/x/id_rsa'), true);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  marker: 'FLOKI_V2_RSI_DATASET_PROVENANCE_PASS',
  manifest_hash_verified: true,
  full_provenance: true,
  dedup: true,
  bounds_enforced: true,
  secrets_refused: true
}, null, 2));
