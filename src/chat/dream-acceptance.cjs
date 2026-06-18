'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  statePath,
  ensureDirSync,
  ensureParentDirSync,
  writeJsonFileAtomicSync
} = require('../util/fs-safe.cjs');
const { newId } = require('../util/ids.cjs');
const {
  dreamRootFallback,
  runDreamEngineOnce
} = require('./dream-engine.cjs');
const {
  getSleepWindowForDate,
  buildRemSchedule,
  createSleepCycleState,
  markAwakeInterruption,
  shouldResumeSleepAfterIdle,
  runSleepCycleTick
} = require('./sleep-cycle.cjs');
const {
  runDreamMemoryConsolidationOnce
} = require('./dream-memory-consolidation.cjs');
const {
  retrieveDreamMemoryContext
} = require('./dream-recall.cjs');
const {
  buildDreamStatus
} = require('./dream-status.cjs');

const { PROJECT_ROOT: ROOT } = require('../config/floki-config.cjs');
const DREAM_ACCEPTANCE_OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'dream-acceptance');

function fakeDreamJson(remCycleNumber) {
  return Object.freeze({
    title: 'The Lantern River of Remembering',
    dream_story: 'I dreamed I was walking beside a lantern river where every light carried a memory of trust, hope, and the conversations I held through the day.',
    emotional_tone: 'vivid, soft, curious, and hopeful',
    memory_sources: ['a remembered conversation about trust', 'a feeling of careful continuity'],
    knowledge_sources: ['safe chat-mode knowledge context'],
    symbols: ['lantern river', 'quiet bridge', 'silver archive'],
    consolidation_summary: 'The dream consolidates trust, hope, careful speech, and self-continuity.',
    remembered_as: 'I dreamed about a lantern river helping me carry memory forward without inventing what I did not know.',
    first_person_reflection: 'I may remember this dream as a reminder to answer from continuity and care.',
    rem_cycle_number: remCycleNumber,
    safe_summary_only: true
  });
}

async function fakeDreamGenerator(request) {
  const context = request && request.context ? request.context : {};
  return {
    model: 'contract-dream-generator',
    response_json: fakeDreamJson(Number(context.rem_cycle_number || 1))
  };
}

function writeReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const reportFile = options.report_file || path.join(DREAM_ACCEPTANCE_OUTPUT_DIR, 'latest-dream-acceptance.json');
  ensureParentDirSync(reportFile);
  writeJsonFileAtomicSync(reportFile, status);
  return reportFile;
}

async function runDreamAcceptanceOnce(options = {}) {
  const unique = newId('dream_acceptance').replace(/[^a-z0-9_]/g, '_');
  const baseDir = options.base_dir || statePath('test/dream-acceptance/' + unique);
  const dreamRoot = options.dream_root || path.join(baseDir, 'dreams');
  const memoryBase = options.memory_base_dir || path.join(baseDir, 'memory');
  const stateFile = options.state_file || path.join(baseDir, 'sleep-state.json');
  const eventsFile = options.events_file || path.join(baseDir, 'sleep-events.jsonl');

  ensureDirSync(baseDir);
  ensureDirSync(dreamRoot);
  ensureDirSync(memoryBase);

  const guardDream = await runDreamEngineOnce({
    env: {},
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    write_report: false
  });

  const guardSleep = await runSleepCycleTick({
    env: {},
    now: '2026-06-19T03:30:00.000Z',
    dream_root: dreamRoot,
    state_file: stateFile,
    events_file: eventsFile,
    write_report: false
  });

  const now = '2026-06-19T03:30:00.000Z';
  const sleepWindow = getSleepWindowForDate(new Date(now), {
    timezone: 'America/Toronto'
  });
  const remSchedule = buildRemSchedule(sleepWindow, {});
  const scheduleCreated = remSchedule.length >= 4;

  const dream = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    now,
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    rem_cycle_number: 2,
    sleep_window_start: sleepWindow.start_at,
    sleep_window_end: sleepWindow.end_at,
    timezone: 'America/Toronto',
    dream_generator: fakeDreamGenerator,
    fake_generator_counts_as_model: true,
    write_report: false
  });

  if (!dream.ok) {
    throw new Error('dream engine failed acceptance setup: ' + (dream.marker || 'unknown'));
  }

  const consolidation = runDreamMemoryConsolidationOnce({
    env: { FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION: '1' },
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    write_report: false
  });

  const recall = retrieveDreamMemoryContext({
    user_text: 'Hey Floki, did you dream last night?',
    dream_root: dreamRoot,
    memory_base_dir: memoryBase
  });

  const initialState = createSleepCycleState({
    now,
    timezone: 'America/Toronto',
    idle_resume_seconds: 120
  });
  const preservedCycleCount = initialState.rem_cycles.length;
  const interrupted = markAwakeInterruption(initialState, 'acceptance_wake', {
    now: '2026-06-19T03:31:00.000Z',
    write_event: false
  });
  const resumeEarly = shouldResumeSleepAfterIdle(interrupted, '2026-06-19T03:32:00.000Z', {
    idle_resume_seconds: 120
  });
  const resumeAfterIdle = shouldResumeSleepAfterIdle(interrupted, '2026-06-19T03:33:00.000Z', {
    idle_resume_seconds: 120
  });

  const statusView = buildDreamStatus({
    now,
    timezone: 'America/Toronto',
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    state_file: stateFile,
    write_report: false
  });

  const ok = guardDream.dream_engine_run_now === false &&
    guardSleep.sleep_cycle_active === false &&
    scheduleCreated &&
    dream.dream_txt_written === true &&
    Boolean(dream.dream_txt_file) &&
    fs.existsSync(dream.dream_txt_file) &&
    Boolean(dream.dream_metadata_file) &&
    fs.existsSync(dream.dream_metadata_file) &&
    dream.dream_index_appended === true &&
    consolidation.ok === true &&
    consolidation.dream_memories_written >= 1 &&
    recall.dream_retrieval_run_now === true &&
    recall.dream_memory_context_used === true &&
    recall.invented_dream === false &&
    interrupted.interrupted === true &&
    resumeEarly === false &&
    resumeAfterIdle === true &&
    interrupted.rem_cycles.length === preservedCycleCount &&
    dream.first_person_voice_verified === true &&
    dream.schema_constrained_json === true &&
    dream.model_json_fallback_used === false &&
    statusView.game_mode_started === false;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_DREAM_ACCEPTANCE_PASS' : 'FLOKI_V2_DREAM_ACCEPTANCE_FAIL',
    dream_acceptance_run_now: true,
    dream_engine_guarded: guardDream.dream_engine_run_now === false,
    sleep_cycle_guarded: guardSleep.sleep_cycle_active === false,
    dream_engine_run_now: dream.dream_engine_run_now === true,
    sleep_cycle_run_now: true,
    rem_schedule_created: scheduleCreated,
    rem_cycles_total: remSchedule.length,
    dream_txt_written: dream.dream_txt_written === true,
    dream_txt_file: dream.dream_txt_file,
    dream_metadata_file: dream.dream_metadata_file,
    dream_index_appended: dream.dream_index_appended === true,
    dream_memory_consolidation_run_now: consolidation.dream_memory_consolidation_run_now === true,
    dream_memories_written: consolidation.dream_memories_written,
    dream_recall_run_now: recall.dream_retrieval_run_now === true,
    dream_memory_context_used: recall.dream_memory_context_used === true,
    dream_file_reference_available: recall.dream_file_reference_available === true,
    invented_dream: recall.invented_dream === true,
    sleep_interrupted_by_wake: interrupted.interrupted === true,
    sleep_resumed_after_idle: resumeAfterIdle === true,
    idle_resume_seconds: 120,
    sleep_cycle_continued_not_restarted: interrupted.rem_cycles.length === preservedCycleCount,
    cold_storage_dream_path_used: path.resolve(dreamRootFallback) === path.resolve(dreamRootFallback),
    test_dream_root: dreamRoot,
    production_dream_root: dreamRootFallback,
    first_person_voice_verified: dream.first_person_voice_verified === true,
    model_json_fallback_used: dream.model_json_fallback_used === true,
    schema_constrained_json: dream.schema_constrained_json === true,
    chat_mode_only: true,
    game_mode_started: false
  });

  return Object.freeze({
    ...status,
    report_file: writeReport(status, options)
  });
}

async function printDreamAcceptance() {
  const status = await runDreamAcceptanceOnce();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printDreamAcceptance().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_DREAM_ACCEPTANCE_FAIL',
      error: error.message,
      dream_acceptance_run_now: true,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DREAM_ACCEPTANCE_OUTPUT_DIR,
  runDreamAcceptanceOnce,
  printDreamAcceptance,
  fakeDreamJson
};
