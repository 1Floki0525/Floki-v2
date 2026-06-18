'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  statePath,
  ensureDirSync,
  writeTextFileAtomicSync
} = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  runKnowledgeIngestionOnce
} = require('../src/chat/knowledge-ingestion.cjs');

function run() {
  const unique = newId('knowledge_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/knowledge-ingestion-guard/' + unique);
  const fixtureDir = path.join(baseDir, 'fixtures');
  const knowledgeRoot = path.join(baseDir, 'knowledge');

  ensureDirSync(fixtureDir);
  writeTextFileAtomicSync(path.join(fixtureDir, 'blocked.txt'), 'This file must not be read or ingested while the guard is closed.');

  const status = runKnowledgeIngestionOnce({
    env: {},
    input_path: fixtureDir,
    knowledge_root: knowledgeRoot,
    report_file: path.join(baseDir, 'should-not-write-report.json')
  });

  assert.equal(status.ok, false);
  assert.equal(status.marker, 'FLOKI_V2_KNOWLEDGE_INGESTION_BLOCKED');
  assert.equal(status.source_count, 0);
  assert.equal(status.chunk_count, 0);
  assert.equal(status.duplicate_chunk_count, 0);
  assert.equal(status.unsupported_count, 0);
  assert.equal(status.failed_count, 0);
  assert.equal(status.persistent_knowledge_used, false);
  assert.equal(status.model_called_now, false);
  assert.equal(status.network_called_now, false);
  assert.equal(status.game_mode_started, false);
  assert.equal(status.report_file, null);
  assert.equal(fs.existsSync(knowledgeRoot), false);
  assert.equal(fs.existsSync(path.join(baseDir, 'should-not-write-report.json')), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_GUARD_CONTRACT_PASS',
    source_count: 0,
    chunk_count: 0,
    persistent_knowledge_used: false,
    model_called_now: false,
    network_called_now: false,
    report_file_written: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_KNOWLEDGE_INGESTION_GUARD_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
