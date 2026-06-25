'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDreamEngineOnce } = require('../src/chat/dream-engine.cjs');
const { reconcileDreamArchive } = require('../src/chat/dream-archive.cjs');

async function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-live-rem-'));
  const memoryBase = path.join(root, 'memory');
  fs.mkdirSync(memoryBase, { recursive: true });

  const result = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    dream_root: root,
    memory_base_dir: memoryBase,
    now: '2026-06-23T04:30:00.000Z',
    rem_cycle_number: 99,
    sleep_window_start: '2026-06-22T23:00:00-04:00',
    sleep_window_end: '2026-06-23T07:00:00-04:00',
    write_report: false
  });

  assert.equal(result.ok, true, 'live REM must produce a passing dream: ' + (result.last_error || result.marker));
  assert.equal(result.stage, 'complete', 'live REM must reach complete stage');
  assert.equal(result.dream_txt_written, true, 'live REM must write a dream text file');
  assert.equal(result.dream_index_appended, true, 'live REM must append the dream index');
  assert.equal(result.model_called_now, true, 'live REM must call the model');
  assert.equal(result.quality_regeneration_attempts || 0, 0, 'live REM must not need regeneration on an isolated empty archive');
  assert.ok(result.story_word_count >= 220, 'live REM dream must meet minimum word count');
  assert.ok(result.story_sentence_count >= 6, 'live REM dream must meet minimum sentence count');
  assert.ok(fs.existsSync(result.dream_txt_file), 'dream text file must exist');

  const archive = reconcileDreamArchive({ dream_root: root });
  assert.equal(archive.archive_count, 1, 'exactly one live dream must be indexed');
  assert.equal(archive.duplicates, 0, 'no duplicate index entries allowed');

  const text = fs.readFileSync(result.dream_txt_file, 'utf8');
  assert.equal(text.includes('Title:'), true, 'dream text must include a title');
  assert.equal(text.includes('Dream story:'), true, 'dream text must include the story section');

  fs.rmSync(root, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_REM_PRODUCTION_PASS',
    live_model_generation: true,
    original_dream_indexed: true,
    no_duplicate_index: true,
    stage: result.stage,
    story_word_count: result.story_word_count,
    story_sentence_count: result.story_sentence_count,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_LIVE_REM_PRODUCTION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
