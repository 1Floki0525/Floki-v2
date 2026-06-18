'use strict';

const assert = require('node:assert/strict');

const {
  runDreamAcceptanceOnce
} = require('../src/chat/dream-acceptance.cjs');

async function run() {
  const status = await runDreamAcceptanceOnce({
    write_report: false
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_DREAM_ACCEPTANCE_PASS');
  assert.equal(status.dream_acceptance_run_now, true);
  assert.equal(status.dream_engine_guarded, true);
  assert.equal(status.sleep_cycle_guarded, true);
  assert.equal(status.dream_engine_run_now, true);
  assert.equal(status.sleep_cycle_run_now, true);
  assert.equal(status.rem_schedule_created, true);
  assert.equal(status.rem_cycles_total >= 4, true);
  assert.equal(status.dream_txt_written, true);
  assert.equal(Boolean(status.dream_txt_file), true);
  assert.equal(Boolean(status.dream_metadata_file), true);
  assert.equal(status.dream_index_appended, true);
  assert.equal(status.dream_memory_consolidation_run_now, true);
  assert.equal(status.dream_memories_written >= 1, true);
  assert.equal(status.dream_recall_run_now, true);
  assert.equal(status.dream_memory_context_used, true);
  assert.equal(status.dream_file_reference_available, true);
  assert.equal(status.invented_dream, false);
  assert.equal(status.sleep_interrupted_by_wake, true);
  assert.equal(status.sleep_resumed_after_idle, true);
  assert.equal(status.idle_resume_seconds, 120);
  assert.equal(status.sleep_cycle_continued_not_restarted, true);
  assert.equal(status.cold_storage_dream_path_used, true);
  assert.equal(status.first_person_voice_verified, true);
  assert.equal(status.model_json_fallback_used, false);
  assert.equal(status.schema_constrained_json, true);
  assert.equal(status.chat_mode_only, true);
  assert.equal(status.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ACCEPTANCE_PASS',
    dream_acceptance_run_now: true,
    dream_engine_run_now: true,
    sleep_cycle_run_now: true,
    rem_schedule_created: true,
    rem_cycles_total: status.rem_cycles_total,
    dream_txt_written: true,
    dream_txt_file: status.dream_txt_file,
    dream_metadata_file: status.dream_metadata_file,
    dream_index_appended: true,
    dream_memory_consolidation_run_now: true,
    dream_memories_written: status.dream_memories_written,
    dream_recall_run_now: true,
    dream_memory_context_used: true,
    sleep_interrupted_by_wake: true,
    sleep_resumed_after_idle: true,
    idle_resume_seconds: 120,
    sleep_cycle_continued_not_restarted: true,
    cold_storage_dream_path_used: true,
    first_person_voice_verified: true,
    model_json_fallback_used: false,
    schema_constrained_json: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_ACCEPTANCE_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
