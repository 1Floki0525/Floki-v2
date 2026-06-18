'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  dreamMemoryConsolidationGuardStatus,
  runDreamMemoryConsolidationOnce
} = require('../src/chat/dream-memory-consolidation.cjs');

function run() {
  const unique = newId('dream_memory_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-memory-consolidation-guard/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');
  ensureDirSync(baseDir);

  const guard = dreamMemoryConsolidationGuardStatus({});
  assert.equal(guard.allowed_now, false);

  const proof = runDreamMemoryConsolidationOnce({
    env: {},
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    write_report: false
  });

  assert.equal(proof.ok, false);
  assert.equal(proof.marker, 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_BLOCKED');
  assert.equal(proof.dream_memory_consolidation_run_now, false);
  assert.equal(proof.dream_files_read, 0);
  assert.equal(proof.dream_memories_written, 0);
  assert.equal(proof.dream_memory_index_appended, false);
  assert.equal(proof.persistent_chat_memory_updated, false);
  assert.equal(fs.existsSync(path.join(dreamRoot, 'dream-memory-index.jsonl')), false);
  assert.equal(fs.existsSync(memoryBase), false);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_GUARD_PASS',
    dream_memory_consolidation_run_now: proof.dream_memory_consolidation_run_now,
    dream_files_read: proof.dream_files_read,
    dream_memories_written: proof.dream_memories_written,
    dream_memory_index_appended: proof.dream_memory_index_appended,
    persistent_chat_memory_updated: proof.persistent_chat_memory_updated,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_MEMORY_CONSOLIDATION_GUARD_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
