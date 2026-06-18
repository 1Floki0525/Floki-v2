'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  dreamEngineGuardStatus,
  runDreamEngineOnce
} = require('../src/chat/dream-engine.cjs');

async function run() {
  const unique = newId('dream_engine_guard').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-engine-guard/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');
  ensureDirSync(baseDir);

  const guard = dreamEngineGuardStatus({});
  assert.equal(guard.ok, true);
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.dream_engine_run_now, false);
  assert.equal(guard.model_called_now, false);
  assert.equal(guard.dream_txt_written, false);
  assert.equal(guard.memory_write_now, false);

  let modelCalls = 0;
  const proof = await runDreamEngineOnce({
    env: {},
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    dream_generator: async function() {
      modelCalls += 1;
      return {};
    },
    write_report: false
  });

  assert.equal(proof.ok, false);
  assert.equal(proof.marker, 'FLOKI_V2_DREAM_ENGINE_BLOCKED');
  assert.equal(proof.dream_engine_run_now, false);
  assert.equal(proof.model_called_now, false);
  assert.equal(modelCalls, 0);
  assert.equal(proof.dream_txt_written, false);
  assert.equal(proof.dream_txt_file, null);
  assert.equal(proof.dream_metadata_file, null);
  assert.equal(proof.dream_index_appended, false);
  assert.equal(proof.persistent_memory_used, false);
  assert.equal(fs.existsSync(dreamRoot), false);
  assert.equal(fs.existsSync(memoryBase), false);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_GUARD_CONTRACT_PASS',
    no_model_call: modelCalls === 0,
    no_file_write: fs.existsSync(dreamRoot) === false,
    no_memory_write: fs.existsSync(memoryBase) === false,
    no_dream_index_append: fs.existsSync(path.join(dreamRoot, 'dream-index.jsonl')) === false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_ENGINE_GUARD_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
