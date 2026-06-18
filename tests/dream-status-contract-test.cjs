'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  statePath,
  ensureDirSync,
  writeJsonFileAtomicSync,
  writeTextFileAtomicSync
} = require('../src/util/fs-safe.cjs');
const { appendJsonlSync } = require('../src/util/jsonl.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createSleepCycleState, markAwakeInterruption } = require('../src/chat/sleep-cycle.cjs');
const { buildDreamStatus } = require('../src/chat/dream-status.cjs');

function run() {
  const unique = newId('dream_status').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-status/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const stateFile = path.join(baseDir, 'sleep-state.json');
  const eventsFile = path.join(baseDir, 'sleep-events.jsonl');
  const now = '2026-06-19T04:32:00.000Z';
  const sleepOptions = {
    now,
    timezone: 'America/Toronto',
    state_file: stateFile,
    events_file: eventsFile,
    dream_root: dreamRoot,
    idle_resume_seconds: 120
  };

  ensureDirSync(dreamRoot);

  let state = createSleepCycleState(sleepOptions);
  state = {
    ...state,
    rem_cycles: state.rem_cycles.map((cycle, index) => index === 0
      ? {
        ...cycle,
        status: 'complete',
        dream_txt_file: path.join(dreamRoot, '2026', '06', '19', 'rem-cycle-01_test_glass-river.txt'),
        dream_metadata_file: path.join(dreamRoot, '2026', '06', '19', 'rem-cycle-01_test_glass-river.json'),
        completed_at: '2026-06-19T04:30:00.000Z'
      }
      : cycle)
  };
  state = markAwakeInterruption(state, 'contract_wake', {
    ...sleepOptions,
    now: '2026-06-19T04:31:00.000Z',
    write_event: false
  });
  writeJsonFileAtomicSync(stateFile, state);

  const dreamTxtFile = state.rem_cycles[0].dream_txt_file;
  const dreamMetadataFile = state.rem_cycles[0].dream_metadata_file;
  ensureDirSync(path.dirname(dreamTxtFile));
  writeTextFileAtomicSync(dreamTxtFile, 'Title: The Glass River Status Dream\nI dreamed about a glass river.\n');
  writeJsonFileAtomicSync(dreamMetadataFile, {
    title: 'The Glass River Status Dream',
    created_at: '2026-06-19T04:30:00.000Z',
    rem_cycle_number: 1,
    dream_txt_file: dreamTxtFile,
    dream_metadata_file: dreamMetadataFile,
    chat_mode_only: true,
    game_mode_started: false
  });

  appendJsonlSync(path.join(dreamRoot, 'dream-index.jsonl'), {
    title: 'The Glass River Status Dream',
    created_at: '2026-06-19T04:30:00.000Z',
    rem_cycle_number: 1,
    dream_txt_file: dreamTxtFile,
    dream_metadata_file: dreamMetadataFile,
    chat_mode_only: true,
    game_mode_started: false
  });

  appendJsonlSync(path.join(dreamRoot, 'dream-memory-index.jsonl'), {
    dream_title: 'The Glass River Status Dream',
    dream_summary: 'I remembered a glass river dream.',
    dream_txt_file: dreamTxtFile,
    dream_metadata_file: dreamMetadataFile,
    persistent_memory_id: 'memory_contract_dream_1',
    created_at: '2026-06-19T04:31:30.000Z',
    chat_mode_only: true,
    game_mode_started: false
  });

  const status = buildDreamStatus(sleepOptions);

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_DREAM_STATUS_PASS');
  assert.equal(status.within_sleep_window, true);
  assert.equal(status.currently_interrupted, true);
  assert.equal(status.currently_sleeping, false);
  assert.equal(status.idle_seconds_remaining_before_resume, 60);
  assert.equal(status.rem_cycles_completed_tonight, 1);
  assert.equal(status.rem_cycles_pending_tonight >= 1, true);
  assert.equal(status.latest_dream_file, dreamTxtFile);
  assert.equal(status.latest_dream_title, 'The Glass River Status Dream');
  assert.equal(status.latest_dream_memory_written, true);
  assert.equal(status.cold_storage_available, true);
  assert.equal(status.chat_mode_only, true);
  assert.equal(status.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_STATUS_PASS',
    currently_sleeping: status.currently_sleeping,
    currently_interrupted: status.currently_interrupted,
    idle_seconds_remaining_before_resume: status.idle_seconds_remaining_before_resume,
    rem_cycles_completed_tonight: status.rem_cycles_completed_tonight,
    rem_cycles_pending_tonight: status.rem_cycles_pending_tonight,
    latest_dream_file: status.latest_dream_file,
    latest_dream_title: status.latest_dream_title,
    latest_dream_memory_written: status.latest_dream_memory_written,
    cold_storage_available: status.cold_storage_available,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_STATUS_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
