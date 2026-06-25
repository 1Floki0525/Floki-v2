'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reconcileDreamArchive } = require('../src/chat/dream-archive.cjs');
const { runDreamEngineOnce } = require('../src/chat/dream-engine.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dream-archive-'));
  const memoryBase = path.join(root, 'memory');
  const day = path.join(root, '2026', '06', '23');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(memoryBase, { recursive: true });

  const text = path.join(day, 'rem-cycle-01.txt');
  const meta = path.join(day, 'rem-cycle-01.json');
  fs.writeFileSync(text, 'Title: Original\n\nDream story:\nI walk through a new city and remember the light.');
  fs.writeFileSync(meta, JSON.stringify({ title: 'Original', created_at: '2026-06-23T04:30:00.000Z', rem_cycle_number: 1, dream_txt_file: text }));

  const first = reconcileDreamArchive({ dream_root: root });
  assert.equal(first.indexed, 1);
  assert.equal(first.archive_count, 1);

  const second = reconcileDreamArchive({ dream_root: root });
  assert.equal(second.indexed, 0);
  assert.equal(second.archive_count, 1);

  const lines = fs.readFileSync(path.join(root, 'dream-index.jsonl'), 'utf8').trim().split(/\n/);
  assert.equal(lines.length, 1);

  const rejected = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    dream_root: root,
    memory_base_dir: memoryBase,
    context: {
      created_at: new Date('2026-06-23T05:00:00.000Z').toISOString(),
      sleep_window_start: '2026-06-22T23:00:00-04:00',
      sleep_window_end: '2026-06-23T07:00:00-04:00',
      timezone: 'America/Toronto',
      dream_grounding_plan: { memory_records: [], knowledge_records: [] },
      recent_dreams_to_avoid: [{
        title: 'Original',
        story_opening: 'I walk through a new city and remember the light.',
        symbols: ['new city', 'light']
      }],
      personality_used: true,
      beliefs_biases_used: true,
      knowledge_context_used: false,
      persistent_memory_used: false,
      emotional_reinforcement_used: false
    },
    dream_generator: () => ({
      title: 'Original',
      dream_story: 'I walk through a new city and remember the light. The streets rearrange themselves behind me and the same pale glow follows my steps.',
      emotional_tone: 'Nostalgic.',
      symbols: ['new city', 'light'],
      consolidation_summary: 'A short consolidation.',
      first_person_reflection: 'I keep walking.'
    }),
    quality_regeneration_attempts: 1,
    write_report: false
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.regeneration_needed, true);
  assert.equal(rejected.dream_txt_written, false);

  const afterReject = reconcileDreamArchive({ dream_root: root });
  assert.equal(afterReject.archive_count, 1, 'a quality-rejected draft must not be indexed');
  assert.equal(afterReject.indexed, 0);

  fs.rmSync(root, { recursive: true, force: true });

  console.log('FLOKI_V2_DREAM_ARCHIVE_RECONCILIATION_CONTRACT_PASS');
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_ARCHIVE_RECONCILIATION_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
