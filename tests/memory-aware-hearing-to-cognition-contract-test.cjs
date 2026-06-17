'use strict';

const assert = require('node:assert/strict');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  hearingToCognitionGuardStatus,
  emotionFromAffectSummary,
  summarizePersistentMemoryForCognition,
  buildPersistentMemoryContext
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function run() {
  const guard = hearingToCognitionGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.marker, 'FLOKI_V2_HEARING_TO_COGNITION_GUARDED');
  assert.equal(guard.allowed_now, false);
  assert.equal(guard.persistent_memory_used, false);
  assert.equal(guard.short_term_memory_written, false);
  assert.equal(guard.long_term_memory_recalled, false);
  assert.equal(guard.emotional_reinforcement_used, false);
  assert.equal(guard.chat_mode_only, true);

  const emotion = emotionFromAffectSummary({
    valence: 0.2,
    arousal: 0.3,
    trust: 0.4,
    hope: 0.5,
    curiosity: 0.6,
    attachment: 0.7
  });

  assert.equal(emotion.valence, 0.2);
  assert.equal(emotion.trust, 0.4);
  assert.equal(emotion.hope, 0.5);
  assert.equal(emotion.curiosity, 0.6);
  assert.equal(emotion.attachment, 0.7);

  const unique = newId('memaware').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/memory-aware-hearing-to-cognition/' + unique);

  const heard = {
    ok: true,
    heard_text: 'Hey Floki, remember that trust and hope should guide our conversations.',
    heard_text_length: 72,
    heard_word_count: 11,
    report_file: '/tmp/fake-hearing-report.json'
  };

  const firstContext = buildPersistentMemoryContext(heard, emotion, {
    memory_base_dir: baseDir,
    importance: 0.9,
    min_consolidation_importance: 0.65,
    reinforcement_signal: 0.3,
    recall_limit: 5
  });

  assert.equal(firstContext.short_memory.stream, 'short_term');
  assert.equal(firstContext.short_memory.tags.includes('hearing_to_cognition'), true);
  assert.equal(firstContext.reinforcement.target_id, 'conversation_habit:respond_when_addressed_by_wake_phrase');
  assert.equal(firstContext.reinforcement.resulting_score > 0, true);
  assert.equal(firstContext.consolidation.promoted_count >= 1, true);
  assert.equal(firstContext.cognition_memory_context.short_term.length >= 1, true);
  assert.equal(firstContext.cognition_memory_context.long_term.length >= 1, true);
  assert.equal(firstContext.cognition_memory_context.recall_ready_for_cognition, true);

  const compact = summarizePersistentMemoryForCognition(firstContext.recall_context);

  assert.equal(compact.short_term.length >= 1, true);
  assert.equal(compact.long_term.length >= 1, true);
  assert.equal(compact.recall_ready_for_cognition, true);
  assert.equal(typeof compact.emotional_state, 'object');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_MEMORY_AWARE_HEARING_TO_COGNITION_CONTRACT_PASS',
    persistent_short_memory_id: firstContext.short_memory.id,
    reinforcement_target: firstContext.reinforcement.target_id,
    reinforcement_score: firstContext.reinforcement.resulting_score,
    promoted_count: firstContext.consolidation.promoted_count,
    short_recall_count: firstContext.cognition_memory_context.short_term.length,
    long_recall_count: firstContext.cognition_memory_context.long_term.length,
    recall_ready_for_cognition: firstContext.cognition_memory_context.recall_ready_for_cognition,
    persistent_memory_used: true,
    emotional_reinforcement_used: true,
    chat_mode_only: true
  }, null, 2));
}

run();
