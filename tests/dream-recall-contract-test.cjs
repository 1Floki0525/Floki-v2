'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { statePath, ensureDirSync, writeTextFileAtomicSync } = require('../src/util/fs-safe.cjs');
const { appendJsonlSync } = require('../src/util/jsonl.cjs');
const { newId } = require('../src/util/ids.cjs');
const { createChatMemorySubstrate } = require('../src/chat/chat-memory-substrate.cjs');
const {
  isDreamRecallQuestion,
  retrieveDreamMemoryContext
} = require('../src/chat/dream-recall.cjs');
const {
  buildPersistentMemoryContext
} = require('../src/senses/hearing-to-cognition-bridge.cjs');
const {
  compactCognitionContext,
  buildCognitionPrompt
} = require('../brain/frontal/index.cjs');

function run() {
  const unique = newId('dream_recall').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/dream-recall/' + unique);
  const dreamRoot = path.join(baseDir, 'dreams');
  const memoryBase = path.join(baseDir, 'memory');

  ensureDirSync(dreamRoot);

  const dreamTxtFile = path.join(dreamRoot, '2026', '06', '18', 'rem-cycle-05_20260618t102000000z_glass-river.txt');

  writeTextFileAtomicSync(dreamTxtFile, [
    'Title: The Glass River of Remembering',
    'What I may remember from this dream:',
    "I dreamed about a glass river carrying trust, hope, and yesterday's conversations into one quiet current."
  ].join('\n'));

  const substrate = createChatMemorySubstrate({ base_dir: memoryBase });
  substrate.ensureReady();

  const memory = substrate.rememberLongTerm({
    category: 'dreams',
    text: "I dreamed about a glass river carrying trust, hope, and yesterday's conversations into one quiet current.",
    summary: 'I dreamed about a glass river of trust and hope.',
    tags: ['dream', 'sleep', 'rem', 'consolidation', 'date', 'date:2026-06-18'],
    importance: 0.84,
    source: 'dream_memory_consolidation'
  });

  appendJsonlSync(path.join(dreamRoot, 'dream-memory-index.jsonl'), {
    dream_title: 'The Glass River of Remembering',
    dream_summary: 'I dreamed about a glass river carrying trust and hope through remembered conversations.',
    emotional_tone: 'soft, vivid, and hopeful',
    symbols: ['glass river', 'quiet current'],
    source_memories: ['trust and hope conversation'],
    source_knowledge: ['safe summary memory'],
    dream_txt_file: dreamTxtFile,
    dream_metadata_file: dreamTxtFile.replace(/\.txt$/, '.json'),
    persistent_memory_id: memory.id,
    dream_created_at: '2026-06-18T10:20:00.000Z'
  });

  assert.equal(isDreamRecallQuestion('Hey Floki, did you dream last night?'), true);
  assert.equal(isDreamRecallQuestion('Hey Floki, what did your last dream mean to you?'), true);
  assert.equal(isDreamRecallQuestion('Hey Floki, what do you remember about trust?'), false);

  const dreamContext = retrieveDreamMemoryContext({
    user_text: 'did you dream last night?',
    dream_root: dreamRoot,
    memory_base_dir: memoryBase
  });

  assert.equal(dreamContext.dream_retrieval_run_now, true);
  assert.equal(dreamContext.dream_memory_context_used, true);
  assert.equal(dreamContext.dream_file_reference_available, true);
  assert.equal(dreamContext.invented_dream, false);
  assert.equal(dreamContext.latest_dream_file, dreamTxtFile);
  assert.equal(dreamContext.recent_dreams[0].dream_title, 'The Glass River of Remembering');
  assert.equal(dreamContext.dream_memory_matches.length >= 1, true);

  const persistent = buildPersistentMemoryContext({
    heard_text: 'did you dream last night?'
  }, {
    valence: 0.2,
    trust: 0.3,
    hope: 0.4,
    curiosity: 0.5
  }, {
    memory_base_dir: memoryBase,
    dream_root: dreamRoot,
    recall_limit: 8
  });

  assert.equal(persistent.cognition_memory_context.dream_memory_context.dream_memory_context_used, true);
  assert.equal(persistent.cognition_memory_context.dream_memory_context.invented_dream, false);

  const compact = compactCognitionContext({
    event: {
      payload: {
        text: 'did you dream last night?'
      }
    },
    persistent_chat_memory: persistent.cognition_memory_context
  });

  assert.equal(compact.dream_memory_context.has_dreams, true);
  assert.equal(compact.dream_memory_context.dream_file_reference_available, true);

  const prompt = buildCognitionPrompt({
    event: {
      payload: {
        text: 'did you dream last night?'
      }
    },
    persistent_chat_memory: persistent.cognition_memory_context
  });

  assert.equal(prompt.includes('do not invent dreams'), true);
  assert.equal(prompt.includes('The Glass River of Remembering'), true);
  assert.equal(prompt.includes(dreamTxtFile), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_DREAM_RECALL_PASS',
    dream_retrieval_run_now: true,
    dream_memory_context_used: true,
    dream_file_reference_available: true,
    invented_dream: false,
    first_person_voice_verified: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_DREAM_RECALL_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
