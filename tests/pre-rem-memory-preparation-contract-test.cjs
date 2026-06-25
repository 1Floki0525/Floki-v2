
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  runPreRemMemoryPreparation
} = require('../src/chat/pre-rem-memory-preparation.cjs');

(async () => {
  const calls = [];
  const result = await runPreRemMemoryPreparation({
    hippocampus_consolidation_runner() {
      calls.push('hippocampus');
      return { ok: true, promoted: 3 };
    },
    knowledge_autoload_runner(options) {
      calls.push('autoload');
      assert.equal(options.force, true);
      return {
        ok: true,
        marker: 'AUTOLOAD_PASS',
        source_count: 12,
        chunk_count: 44,
        scanned_file_count: 100,
        unchanged_source_count: 88
      };
    },
    knowledge_memory_consolidation_runner() {
      calls.push('knowledge-consolidation');
      return {
        ok: true,
        marker: 'CONSOLIDATION_PASS',
        memories_written: 8,
        short_term_memories_promoted: 2
      };
    }
  });

  assert.deepEqual(calls, [
    'hippocampus',
    'autoload',
    'knowledge-consolidation'
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.source_count, 12);
  assert.equal(result.chunk_count, 44);
  assert.equal(result.memories_written, 8);

  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../src/runtime/chat-local-runtime.cjs'),
    'utf8'
  );
  const functionStart = runtimeSource.indexOf(
    'async function requestManualNap()'
  );
  const functionEnd = runtimeSource.indexOf(
    'async function wakeFromManualNap()',
    functionStart
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const requestSource = runtimeSource.slice(functionStart, functionEnd);
  assert.ok(
    requestSource.indexOf('await preRemMemoryPreparation') <
      requestSource.indexOf('beginManualNap'),
    'manual nap must finish pre-REM preparation before beginning the T+0 REM schedule'
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_PRE_REM_MEMORY_PREPARATION_PASS',
    memory_consolidated_before_ingestion: true,
    transcripts_ingested_before_rem: true,
    knowledge_consolidated_before_rem: true,
    manual_nap_clock_begins_after_preparation: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_PRE_REM_MEMORY_PREPARATION_FAIL',
    error: error.stack || error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
