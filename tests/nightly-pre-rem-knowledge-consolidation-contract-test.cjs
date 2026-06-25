'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSleepCycleState,
  ensurePreRemMemoryConsolidation
} = require('../src/chat/sleep-cycle.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pre-rem-memory-'));
  try {
    const stateFile = path.join(root, 'sleep-state.json');
    const eventsFile = path.join(root, 'sleep-events.jsonl');
    const now = '2026-06-24T03:00:00.000Z';
    const window = {
      sleep_date: '2026-06-23',
      start_at: '2026-06-24T02:00:00.000Z',
      end_at: '2026-06-24T10:00:00.000Z',
      timezone: 'America/Toronto'
    };
    const state = createSleepCycleState({ now, sleep_window: window, rem_offsets_minutes: [10, 20] });
    const calls = [];
    const options = {
      now,
      state_file: stateFile,
      events_file: eventsFile,
      write_report: false,
      knowledge_autoload_runner(input) { calls.push(['autoload', input.force]); return { ok: true, marker: 'AUTOLOAD_PASS', source_count: 3, chunk_count: 42 }; },
      knowledge_memory_consolidation_runner() { calls.push(['consolidate']); return { ok: true, marker: 'CONSOLIDATE_PASS', memories_written: 12, short_term_memories_promoted: 2 }; }
    };
    const first = await ensurePreRemMemoryConsolidation(state, options);
    assert.equal(first.ran_now, true);
    assert.equal(first.state.pre_rem_memory_consolidation.completed, true);
    assert.equal(first.state.pre_rem_memory_consolidation.memories_written, 12);
    assert.deepEqual(calls, [['autoload', true], ['consolidate']]);

    const second = await ensurePreRemMemoryConsolidation(first.state, options);
    assert.equal(second.ran_now, false);
    assert.deepEqual(calls, [['autoload', true], ['consolidate']]);
    const events = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter((entry) => entry.type === 'pre_rem_memory_consolidation_complete').length, 1);

    console.log('FLOKI_V2_NIGHTLY_PRE_REM_KNOWLEDGE_CONSOLIDATION_PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
