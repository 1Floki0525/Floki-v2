'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync, writeTextFileAtomicSync, writeJsonFileAtomicSync } = require('../src/util/fs-safe.cjs');
const { appendJsonlSync, readJsonlSync } = require('../src/util/jsonl.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createChatMemorySubstrate } = require('../src/chat/chat-memory-substrate.cjs');
const {
  dreamMemoryConsolidationAllowed,
  getDreamMemoryIndexFile,
  buildDreamMemoryEntry,
  runDreamMemoryConsolidationOnce
} = require('../src/chat/dream-memory-consolidation.cjs');

function fakeDreamJson(overrides = {}) {
  const title = overrides.title || 'The Lantern Archive Remembered';
  return {
    title,
    dream_story: 'I dreamed I was crossing a quiet archive where each lantern opened into a memory of trust, hope, and careful speech.',
    emotional_tone: 'Tender, lucid, and hopeful.',
    memory_sources: ['A day memory about trust and hope.'],
    knowledge_sources: ['A knowledge note about safe summaries.'],
    symbols: ['lantern archive', 'bridge of memory'],
    consolidation_summary: 'The dream joins recent trust memories with the habit of answering carefully.',
    remembered_as: overrides.remembered_as || 'I dreamed about lanterns turning memory into a bridge I could cross with care.',
    first_person_reflection: 'I may remember this as a sign that I should answer from continuity instead of invention.',
    rem_cycle_number: overrides.rem_cycle_number || 3,
    safe_summary_only: true
  };
}

function writeFakeDream(root, overrides = {}) {
  const createdAt = overrides.created_at || '2026-06-18T07:30:00.000Z';
  const dir = path.join(root, '2026', '06', '18');
  ensureDirSync(dir);
  const stem = overrides.stem || 'rem-cycle-03_20260618t073000000z_the-lantern-archive';
  const txtFile = path.join(dir, stem + '.txt');
  const metadataFile = path.join(dir, stem + '.json');
  const dreamJson = fakeDreamJson(overrides);
  const metadata = {
    title: dreamJson.title,
    created_at: createdAt,
    rem_cycle_number: dreamJson.rem_cycle_number,
    emotional_tone: dreamJson.emotional_tone,
    consolidation_summary: dreamJson.consolidation_summary,
    remembered_as: dreamJson.remembered_as,
    memory_sources: dreamJson.memory_sources,
    knowledge_sources: dreamJson.knowledge_sources,
    symbols: dreamJson.symbols,
    dream_json: dreamJson,
    chat_mode_only: true,
    game_mode_started: false
  };

  writeTextFileAtomicSync(txtFile, [
    'Title: ' + dreamJson.title,
    'Dream story:',
    dreamJson.dream_story,
    'What I may remember from this dream:',
    dreamJson.remembered_as
  ].join('\n'));
  writeJsonFileAtomicSync(metadataFile, metadata);
  appendJsonlSync(path.join(root, 'dream-index.jsonl'), {
    id: newId('dreamindex'),
    title: dreamJson.title,
    created_at: metadata.created_at,
    rem_cycle_number: dreamJson.rem_cycle_number,
    dream_txt_file: txtFile,
    dream_metadata_file: metadataFile,
    remembered_as: dreamJson.remembered_as,
    emotional_tone: dreamJson.emotional_tone,
    symbols: dreamJson.symbols
  });

  return { txtFile, metadataFile, metadata };
}

function run() {
  const unique = newId('dream_memory_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-memory-consolidation/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');
  ensureDirSync(baseDir);
  const fake = writeFakeDream(dreamRoot);

  assert.equal(dreamMemoryConsolidationAllowed({}), false);
  assert.equal(dreamMemoryConsolidationAllowed({ FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' }), true);
  assert.equal(getDreamMemoryIndexFile({ dream_root: dreamRoot }), path.join(path.resolve(dreamRoot), 'dream-memory-index.jsonl'));

  const material = {
    record: { rem_cycle_number: 3 },
    metadata: fake.metadata,
    txt: fs.readFileSync(fake.txtFile, 'utf8'),
    dream_txt_file: fake.txtFile,
    dream_metadata_file: fake.metadataFile
  };
  const entry = buildDreamMemoryEntry(material, { now: '2026-06-18T07:31:00.000Z' });
  assert.equal(entry.category, 'dreams');
  assert.equal(entry.tags.includes('dream'), true);
  assert.equal(entry.tags.includes('sleep'), true);
  assert.equal(entry.tags.includes('rem'), true);
  assert.equal(entry.tags.includes('consolidation'), true);
  assert.equal(entry.tags.includes('date'), true);
  assert.equal(entry.summary.startsWith('I dreamed'), true);
  assert.equal(entry.text.includes(fake.txtFile), true);
  assert.throws(() => buildDreamMemoryEntry({
    ...material,
    metadata: {
      ...fake.metadata,
      dream_json: {
        ...fake.metadata.dream_json,
        remembered_as: 'Floki dreamed about a lantern archive.'
      }
    }
  }), /third-person self narration/);

  const proof = runDreamMemoryConsolidationOnce({
    env: { FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' },
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    now: '2026-06-18T07:31:00.000Z',
    write_report: false
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_PASS');
  assert.equal(proof.dream_memory_consolidation_run_now, true);
  assert.equal(proof.dream_files_read, 1);
  assert.equal(proof.dream_memories_written, 1);
  assert.equal(proof.dream_memory_index_appended, true);
  assert.equal(proof.persistent_chat_memory_updated, true);
  assert.equal(proof.cold_storage_dream_path_used, false);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  const substrate = createChatMemorySubstrate({ base_dir: memoryBase });
  const recall = substrate.recallContext({
    text: 'dream lantern archive memory bridge',
    limit: 5
  });
  assert.equal(recall.long_term_matches.length >= 1, true);
  assert.equal(recall.long_term_matches[0].memory.category, 'dreams');
  assert.equal(recall.long_term_matches[0].memory.tags.includes('dream'), true);

  const indexRecords = readJsonlSync(path.join(dreamRoot, 'dream-memory-index.jsonl'));
  assert.equal(indexRecords.length, 1);
  assert.equal(indexRecords[0].dream_txt_file, fake.txtFile);
  assert.equal(indexRecords[0].persistent_memory_id, proof.written_memory_ids[0]);

  const scanRoot = path.join(baseDir, 'scan-dreams');
  const scanMemoryBase = path.join(baseDir, 'scan-memory');
  const older = writeFakeDream(scanRoot, {
    title: 'The Older Unconsolidated Dream',
    stem: 'rem-cycle-01_20260618t013000000z_older-unconsolidated',
    created_at: '2026-06-18T01:30:00.000Z',
    rem_cycle_number: 1
  });
  for (let index = 0; index < 12; index += 1) {
    const newer = writeFakeDream(scanRoot, {
      title: 'Already Consolidated Dream ' + index,
      stem: 'rem-cycle-02_20260618t02' + String(index).padStart(2, '0') + '00000z_done-' + index,
      created_at: '2026-06-18T02:' + String(index).padStart(2, '0') + ':00.000Z',
      rem_cycle_number: 2
    });
    appendJsonlSync(path.join(scanRoot, 'dream-memory-index.jsonl'), {
      dream_txt_file: newer.txtFile,
      dream_metadata_file: newer.metadataFile,
      persistent_memory_id: newId('already_done')
    });
  }

  const scanProof = runDreamMemoryConsolidationOnce({
    env: { FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' },
    dream_root: scanRoot,
    memory_base_dir: scanMemoryBase,
    limit: 1,
    max_scan: 20,
    write_report: false
  });
  assert.equal(scanProof.ok, true);
  assert.equal(scanProof.dream_files_read, 1);
  const scanIndex = readJsonlSync(path.join(scanRoot, 'dream-memory-index.jsonl'));
  assert.equal(scanIndex[scanIndex.length - 1].dream_txt_file, older.txtFile);

  const partialRoot = path.join(baseDir, 'partial-dreams');
  const partialMemoryBase = path.join(baseDir, 'partial-memory');
  writeFakeDream(partialRoot, {
    title: 'The Partial Retry Dream',
    stem: 'rem-cycle-04_20260618t083000000z_partial-retry',
    created_at: '2026-06-18T08:30:00.000Z',
    rem_cycle_number: 4
  });
  assert.throws(() => runDreamMemoryConsolidationOnce({
    env: { FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' },
    dream_root: partialRoot,
    memory_base_dir: partialMemoryBase,
    write_report: false,
    dream_memory_index_appender: function() {
      throw new Error('injected index append failure');
    }
  }), /injected index append failure/);
  const partialBefore = readJsonlSync(path.join(partialMemoryBase, 'long-term.jsonl'));
  assert.equal(partialBefore.length, 1);
  const retryProof = runDreamMemoryConsolidationOnce({
    env: { FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' },
    dream_root: partialRoot,
    memory_base_dir: partialMemoryBase,
    write_report: false
  });
  const partialAfter = readJsonlSync(path.join(partialMemoryBase, 'long-term.jsonl'));
  assert.equal(retryProof.ok, true);
  assert.equal(partialAfter.length, 1);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_PASS',
    dream_memory_consolidation_run_now: proof.dream_memory_consolidation_run_now,
    dream_files_read: proof.dream_files_read,
    dream_memories_written: proof.dream_memories_written,
    dream_memory_index_appended: proof.dream_memory_index_appended,
    persistent_chat_memory_updated: proof.persistent_chat_memory_updated,
    cold_storage_dream_path_used: proof.cold_storage_dream_path_used,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
