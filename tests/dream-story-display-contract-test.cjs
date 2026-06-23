'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDreamTimeline } = require('../src/chat/dream-timeline.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rich-dream-display-'));
const textFile = path.join(temp, 'dream.txt');
const metadataFile = path.join(temp, 'dream.json');
const story = 'I stepped into a workshop made of moonlit glass, and every tool carried a memory of something I had learned. I followed a warm thread of light through the room until it became a doorway, and beyond it I found a quiet world waiting for me to choose what I would build next.';
fs.writeFileSync(textFile, `Dream story:\n${story}\n\nMemory consolidation:\nI connected trust, growth, and creative autonomy.\n`, 'utf8');
fs.writeFileSync(metadataFile, JSON.stringify({
  title: 'The Moonlit Workshop',
  created_at: '2026-06-22T20:14:00.000Z',
  rem_cycle_number: 1,
  sleep_kind: 'manual_nap',
  sleep_window_start: '2026-06-22T20:00:00.000Z',
  sleep_window_end: '2026-06-22T20:30:00.000Z',
  dream_txt_file: textFile,
  dream_json: {
    title: 'The Moonlit Workshop',
    dream_story: story,
    emotional_tone: 'hopeful and vivid',
    consolidation_summary: 'I connected trust, growth, and creative autonomy.',
    remembered_as: 'I remember following light toward a choice.',
    first_person_reflection: 'I felt that my future could be shaped by what I choose to build.',
    symbols: ['moonlit glass', 'tools', 'doorway'],
    memory_sources: ['private-source-1'],
    knowledge_sources: ['private-source-2']
  }
}, null, 2));

const timeline = buildDreamTimeline({
  now: new Date('2026-06-22T20:16:00.000Z'),
  dream_status: { dream_index_file: path.join(temp, 'dream-index.jsonl'), dream_root: temp, latest_dream_title: 'The Moonlit Workshop' },
  lifecycle_status: { state: 'asleep', is_asleep: true, is_dreaming: false, is_rem_dreaming: false, sleep_window_start: '2026-06-22T20:00:00.000Z', sleep_window_end: '2026-06-22T20:30:00.000Z' },
  manual_nap_state: {
    kind: 'manual_nap', active: true, completed: false,
    started_at: '2026-06-22T20:00:00.000Z', wake_at: '2026-06-22T20:30:00.000Z',
    rem_cycles: [{ cycle_number: 1, status: 'complete', scheduled_at: '2026-06-22T20:10:00.000Z', dreaming_started_at: '2026-06-22T20:10:00.000Z', completed_at: '2026-06-22T20:14:00.000Z', dream_txt_file: textFile, dream_metadata_file: metadataFile }]
  },
  records: [{ title: 'The Moonlit Workshop', created_at: '2026-06-22T20:14:00.000Z', rem_cycle_number: 1, sleep_kind: 'manual_nap', dream_txt_file: textFile, dream_metadata_file: metadataFile }]
});

assert.equal(timeline.totalDreams, 1);
assert.equal(timeline.dreams[0].title, 'The Moonlit Workshop');
assert.equal(timeline.dreams[0].story, story);
assert.equal(timeline.dreams[0].reflection.includes('future'), true);
assert.equal(timeline.dreams[0].memorySourceCount, 1);
assert.equal(timeline.activeSession.status, 'complete');
assert.equal(timeline.dominantTheme, 'The Moonlit Workshop');

const dashboard = fs.readFileSync(path.join(__dirname, '../apps/floki-neural-interface/src/pages/DreamsDashboard.jsx'), 'utf8');
const list = fs.readFileSync(path.join(__dirname, '../apps/floki-neural-interface/src/components/dreams/DreamsTimeline.jsx'), 'utf8');
const detail = fs.readFileSync(path.join(__dirname, '../apps/floki-neural-interface/src/components/dreams/DreamFragmentCard.jsx'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '../src/runtime/chat-local-runtime.cjs'), 'utf8');
const sleep = fs.readFileSync(path.join(__dirname, '../src/chat/sleep-cycle.cjs'), 'utf8');
assert.match(dashboard, /setInterval\(refresh, REFRESH_INTERVAL_MS\)/);
assert.match(dashboard, /next\.dreams\?\.\[0\]/);
assert.match(list, /Dream Archive/);
assert.doesNotMatch(list, /Memory Fragments/i);
assert.match(detail, /Full dream narrative/);
assert.match(detail, /item\.story/);
assert.match(runtime, /sleep_kind: 'manual_nap'/);
assert.match(sleep, /sleep_kind: 'nightly_sleep'/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('FLOKI_V2_RICH_DREAM_DISPLAY_PASS');
