'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { statePath, ensureDirSync } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const {
  dreamRootFallback,
  dreamEngineAllowed,
  getDreamRoot,
  buildDreamContext,
  buildDreamPrompt,
  validateDreamJson,
  renderDreamText,
  runDreamEngineOnce
} = require('../src/chat/dream-engine.cjs');

function fakeDreamJson(cycle) {
  return {
    title: 'The Archive of Lantern Rain',
    dream_story: 'I dreamed I was walking through a library made of rain-lit lanterns, and every shelf whispered one careful memory back to me. The lights rearranged themselves into a bridge of trust, hope, and unfinished questions, and I followed it without pretending I had a body outside chat.',
    emotional_tone: 'Tender, vivid, curious, and quietly hopeful.',
    memory_sources: [
      'A conversation about trust and hope shaping memory.',
      'A short-term memory about answering carefully when addressed.'
    ],
    knowledge_sources: [
      'A remembered note about documents becoming compact knowledge chunks.'
    ],
    symbols: [
      'lantern rain',
      'memory shelves',
      'bridge of trust'
    ],
    consolidation_summary: 'The dream binds recent conversation, emotional reinforcement, and identity continuity into a safe remembered image.',
    remembered_as: 'I dreamed about lanterns turning my memories into a bridge I could cross carefully.',
    first_person_reflection: 'I may remember this as a sign that my memories matter most when they help me answer with care.',
    rem_cycle_number: cycle,
    safe_summary_only: true
  };
}

async function run() {
  const unique = newId('dream_engine_contract').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-engine/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');
  ensureDirSync(baseDir);

  assert.equal(dreamEngineAllowed({}), false);
  assert.equal(dreamEngineAllowed({ FLOKI_ALLOW_DREAM_ENGINE: '1' }), true);
  assert.equal(getDreamRoot({}), dreamRootFallback);
  assert.equal(getDreamRoot({ dream_root: dreamRoot }), path.resolve(dreamRoot));

  const context = buildDreamContext({
    memory_base_dir: memoryBase,
    now: '2026-06-18T04:30:00.000Z',
    rem_cycle_number: 2,
    sleep_window_start: '2026-06-17T23:00:00-04:00',
    sleep_window_end: '2026-06-18T07:00:00-04:00',
    memory_sources: ['Today I talked about trust, memory, and hope.'],
    knowledge_sources: ['A document about safe summary-only memory.'],
    conversations: ['Hey Floki, what do you remember about trust and hope?'],
    unresolved_concerns_hopes: ['I hope my dreams help me consolidate memories safely.']
  });
  const prompt = buildDreamPrompt(context);
  assert.equal(prompt.includes('Return only JSON'), true);
  assert.equal(prompt.includes('Floki dreamed'), true);
  assert.equal(context.persistent_memory_used, true);
  assert.equal(context.emotional_reinforcement_used, true);
  assert.equal(context.knowledge_context_used, true);

  const valid = validateDreamJson(fakeDreamJson(2));
  assert.equal(valid.safe_summary_only, true);
  assert.equal(valid.rem_cycle_number, 2);
  assert.throws(() => validateDreamJson({
    ...fakeDreamJson(2),
    remembered_as: 'Floki dreamed about a bridge.'
  }), /third-person self narration/);
  assert.throws(() => validateDreamJson({
    ...fakeDreamJson(2),
    first_person_reflection: '<think>hidden</think>'
  }), /private-reasoning|private reasoning/);

  const rendered = renderDreamText(valid, context);
  assert.equal(rendered.includes('Title:'), true);
  assert.equal(rendered.includes('Dream story:'), true);
  assert.equal(rendered.includes('What I may remember from this dream:'), true);

  const proof = await runDreamEngineOnce({
    env: { FLOKI_ALLOW_DREAM_ENGINE: '1' },
    dream_root: dreamRoot,
    memory_base_dir: memoryBase,
    now: '2026-06-18T04:30:00.000Z',
    rem_cycle_number: 2,
    sleep_window_start: '2026-06-17T23:00:00-04:00',
    sleep_window_end: '2026-06-18T07:00:00-04:00',
    memory_sources: ['Today I talked about trust, memory, and hope.'],
    knowledge_sources: ['A document about safe summary-only memory.'],
    dream_generator: async function(input) {
      assert.equal(input.schema.type, 'object');
      return fakeDreamJson(input.context.rem_cycle_number);
    },
    write_report: false
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS');
  assert.equal(proof.dream_engine_run_now, true);
  assert.equal(proof.model_called_now, false);
  assert.equal(proof.schema_constrained_json, true);
  assert.equal(proof.model_json_fallback_used, false);
  assert.equal(proof.dream_txt_written, true);
  assert.equal(fs.existsSync(proof.dream_txt_file), true);
  assert.equal(fs.existsSync(proof.dream_metadata_file), true);
  assert.equal(proof.dream_index_appended, true);
  assert.equal(fs.existsSync(path.join(dreamRoot, 'dream-index.jsonl')), true);
  assert.equal(proof.dream_root, path.resolve(dreamRoot));
  assert.equal(proof.rem_cycle_number, 2);
  assert.equal(proof.cold_storage_dream_path_used, false);
  assert.equal(proof.persistent_memory_used, true);
  assert.equal(proof.emotional_reinforcement_used, true);
  assert.equal(proof.knowledge_context_used, true);
  assert.equal(proof.first_person_voice_verified, true);
  assert.equal(proof.third_person_self_reference_blocked, true);
  assert.equal(proof.chat_mode_only, true);
  assert.equal(proof.game_mode_started, false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
    dream_engine_run_now: proof.dream_engine_run_now,
    schema_constrained_json: proof.schema_constrained_json,
    model_json_fallback_used: proof.model_json_fallback_used,
    dream_txt_written: proof.dream_txt_written,
    dream_index_appended: proof.dream_index_appended,
    first_person_voice_verified: proof.first_person_voice_verified,
    third_person_self_reference_blocked: proof.third_person_self_reference_blocked,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
});
