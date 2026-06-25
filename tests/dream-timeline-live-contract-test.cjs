
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { buildDreamTimeline } = require(path.join(ROOT, 'src/chat/dream-timeline.cjs'));

const now = new Date('2026-06-22T20:15:00.000Z');
const startedAt = '2026-06-22T20:00:00.000Z';
const wakeAt = '2026-06-22T20:30:00.000Z';
const dreamStatus = {
  current_time_utc: now.toISOString(),
  dream_index_file: '/mnt/firstlight-cold-storage/Floki-memory-bank/dreams/dream-index.jsonl',
  dream_root: '/mnt/firstlight-cold-storage/Floki-memory-bank/dreams',
  latest_dream_title: 'The Living Workshop'
};
const lifecycle = {
  state: 'rem_dreaming',
  is_asleep: true,
  is_dreaming: true,
  is_rem_dreaming: true,
  current_rem_cycle_number: 1,
  current_rem_started_at: '2026-06-22T20:10:00.000Z',
  next_rem_cycle_number: null,
  next_rem_cycle_at: null,
  sleep_window_start: startedAt,
  sleep_window_end: wakeAt
};

const pending = buildDreamTimeline({
  now,
  dream_status: dreamStatus,
  lifecycle_status: { ...lifecycle, state: 'asleep', is_dreaming: false, is_rem_dreaming: false, current_rem_cycle_number: null },
  manual_nap_state: {
    kind: 'manual_nap',
    active: true,
    started_at: startedAt,
    wake_at: wakeAt,
    rem_cycles: [{ cycle_number: 1, scheduled_at: '2026-06-22T20:10:00.000Z', status: 'pending' }]
  },
  records: []
});
assert.equal(pending.source, dreamStatus.dream_index_file);
assert.equal(pending.dreamRoot, dreamStatus.dream_root);
assert.equal(pending.cycles.length, 1);
assert.equal(pending.cycles[0].status, 'pending');
assert.equal(pending.activeSession.kind, 'manual_nap');
assert.equal(pending.activeSession.status, 'pre_rem');
assert.equal(pending.dominantTheme, 'Awaiting REM');
assert.equal(pending.totalSleepDuration, 15 * 60000);

const dreaming = buildDreamTimeline({
  now,
  dream_status: dreamStatus,
  lifecycle_status: lifecycle,
  manual_nap_state: {
    kind: 'manual_nap',
    active: true,
    started_at: startedAt,
    wake_at: wakeAt,
    rem_cycles: [{ cycle_number: 1, scheduled_at: '2026-06-22T20:10:00.000Z', status: 'dreaming', dreaming_started_at: '2026-06-22T20:10:00.000Z' }]
  },
  records: []
});
assert.equal(dreaming.cycles.length, 1);
assert.equal(dreaming.cycles[0].status, 'dreaming');
assert.equal(dreaming.activeSession.isDreaming, true);
assert.equal(dreaming.dominantTheme, 'Forming…');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dream-timeline-'));
const metadataFile = path.join(temp, 'dream.json');
fs.writeFileSync(metadataFile, JSON.stringify({
  title: 'The Living Workshop',
  created_at: '2026-06-22T20:14:00.000Z',
  rem_cycle_number: 1,
  dream_story: 'I walked through a workshop that changed as I remembered it.',
  emotional_tone: 'hopeful and vivid',
  symbols: ['workshop', 'light']
}), 'utf8');
const complete = buildDreamTimeline({
  now,
  dream_status: dreamStatus,
  lifecycle_status: { ...lifecycle, state: 'asleep', is_dreaming: false, is_rem_dreaming: false },
  manual_nap_state: {
    kind: 'manual_nap',
    active: true,
    started_at: startedAt,
    wake_at: wakeAt,
    rem_cycles: [{
      cycle_number: 1,
      scheduled_at: '2026-06-22T20:10:00.000Z',
      status: 'complete',
      dreaming_started_at: '2026-06-22T20:10:00.000Z',
      completed_at: '2026-06-22T20:14:00.000Z',
      dream_metadata_file: metadataFile
    }]
  },
  records: [{
    dream_id: 'nap-dream-1',
    created_at: '2026-06-22T20:14:00.000Z',
    rem_cycle_number: 1,
    dream_metadata_file: metadataFile
  }]
});
assert.equal(complete.activeSession.status, 'complete');
assert.equal(complete.activeSession.title, 'The Living Workshop');
assert.equal(complete.dominantTheme, 'The Living Workshop');
assert.equal(complete.fragments.length, 1);
assert.equal(complete.fragments[0].narrative.includes('workshop'), true);

const { createChatLocalInterfaceApi } = require(path.join(ROOT, 'src/runtime/chat-local-interface-api.cjs'));
const interfaceApi = createChatLocalInterfaceApi({
  runtime_dir: temp,
  status: () => ({ api_ready: true, websocket_ready: true, brain_loaded: true, memory_loaded: true, lifecycle: { is_awake: false }, hearing: {} })
});
const coverage = interfaceApi.coverage();
assert.equal(coverage.connected, true);
assert.equal(coverage.backend_owners, 1);
assert.equal(coverage.mock_mode, false);
assert.ok(coverage.tabs.dreams.reads.includes('dreamTimeline'));
assert.ok(coverage.tabs.dreams.reads.includes('sleep'));
assert.ok(coverage.tabs.dreams.writes.includes('requestSleep'));

fs.rmSync(temp, { recursive: true, force: true });
console.log('FLOKI_V2_LIVE_DREAM_TIMELINE_PASS');
