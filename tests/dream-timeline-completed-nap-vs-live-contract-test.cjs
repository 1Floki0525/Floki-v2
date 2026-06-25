'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDreamTimeline } = require('../src/chat/dream-timeline.cjs');

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-dream-state-'));
  const manualNapFile = path.join(dir, 'manual-nap.json');
  const now = new Date('2026-06-24T20:00:00.000Z');
  fs.writeFileSync(manualNapFile, JSON.stringify({
    kind: 'manual_nap',
    active: false,
    completed: true,
    started_at: now.toISOString(),
    wake_at: new Date(now.getTime() + 30 * 60000).toISOString(),
    completed_at: new Date(now.getTime() + 30 * 60000).toISOString(),
    rem_cycles: [
      { cycle_number: 1, scheduled_at: new Date(now.getTime() + 10 * 60000).toISOString(), status: 'complete' },
      { cycle_number: 2, scheduled_at: new Date(now.getTime() + 20 * 60000).toISOString(), status: 'complete' }
    ]
  }, null, 2));

  const timeline = buildDreamTimeline({
    now: new Date('2026-06-24T21:00:00.000Z'),
    dream_status: {
      dream_index_file: path.join(dir, 'nonexistent.jsonl'),
      dream_root: dir,
      latest_dream_title: null
    },
    lifecycle_status: {
      state: 'awake',
      is_awake: true,
      is_asleep: false,
      is_dreaming: false,
      is_rem_dreaming: false,
      sleep_window_start: null,
      sleep_window_end: null,
      current_rem_cycle_number: null,
      next_rem_cycle_at: null
    },
    manual_nap_state: JSON.parse(fs.readFileSync(manualNapFile, 'utf8')),
    sleep_cycle_state: null,
    records: []
  });

  assert.equal(timeline.activeSession.active, false, 'completed manual nap must not be active');
  assert.notEqual(timeline.activeSession.kind, 'manual_nap', 'completed manual nap must not be the active kind');

  const dashboard = fs.readFileSync(
    path.join(__dirname, '../apps/floki-neural-interface/src/components/dreams/DreamsHeader.jsx'),
    'utf8'
  );
  assert.match(dashboard, /liveStatus\?\.lifecycleState/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_TIMELINE_COMPLETED_NAP_VS_LIVE_PASS',
    active_session_active: timeline.activeSession.active,
    active_session_kind: timeline.activeSession.kind,
    live_state_present: Boolean(timeline.liveStatus),
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
