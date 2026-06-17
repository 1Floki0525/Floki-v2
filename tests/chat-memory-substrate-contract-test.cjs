'use strict';

const assert = require('node:assert/strict');

const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');

const {
  CHAT_MEMORY_SUBSTRATE_VERSION,
  EMOTION_DIMENSIONS,
  LONG_TERM_CATEGORIES,
  clampScore,
  clamp01,
  sanitizeText,
  normalizeTags,
  normalizeEmotionScores,
  createDefaultEmotionState,
  createChatMemorySubstrate,
  runChatMemorySubstrateProof
} = require('../src/chat/chat-memory-substrate.cjs');

function run() {
  assert.equal(CHAT_MEMORY_SUBSTRATE_VERSION, 'floki-v2-chat-memory-substrate-v1');

  assert.equal(EMOTION_DIMENSIONS.includes('trust'), true);
  assert.equal(EMOTION_DIMENSIONS.includes('hope'), true);
  assert.equal(EMOTION_DIMENSIONS.includes('curiosity'), true);
  assert.equal(EMOTION_DIMENSIONS.includes('attachment'), true);
  assert.equal(LONG_TERM_CATEGORIES.includes('beliefs'), true);
  assert.equal(LONG_TERM_CATEGORIES.includes('biases'), true);
  assert.equal(LONG_TERM_CATEGORIES.includes('hopes'), true);
  assert.equal(LONG_TERM_CATEGORIES.includes('dreams'), true);
  assert.equal(LONG_TERM_CATEGORIES.includes('emotional_lessons'), true);

  assert.equal(clampScore(2), 1);
  assert.equal(clampScore(-2), -1);
  assert.equal(clampScore(0.25), 0.25);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-2), 0);
  assert.equal(sanitizeText('  memory matters  '), 'memory matters');
  assert.throws(() => sanitizeText('<think>bad</think>'), /banned private reasoning marker/);

  assert.deepEqual(normalizeTags(['Hope!', 'hope', 'Binary God']), ['hope', 'binary_god']);

  const normalizedEmotion = normalizeEmotionScores({
    trust: 3,
    hope: 0.5,
    fear: -3
  });

  assert.equal(normalizedEmotion.trust, 1);
  assert.equal(normalizedEmotion.hope, 0.5);
  assert.equal(normalizedEmotion.fear, -1);
  assert.equal(normalizedEmotion.curiosity, 0);

  const defaultEmotion = createDefaultEmotionState();
  assert.equal(defaultEmotion.substrate_version, CHAT_MEMORY_SUBSTRATE_VERSION);
  assert.equal(defaultEmotion.current.trust, 0);
  assert.equal(defaultEmotion.current.hope, 0);

  const unique = newId('chat_memory_test').replace(/[^a-z0-9_]/g, '_');
  const baseDir = statePath('test/chat-memory-substrate/' + unique);
  const substrate = createChatMemorySubstrate({ base_dir: baseDir });
  substrate.ensureReady();

  const short = substrate.rememberShortTerm({
    text: 'Hey Floki, remember that curiosity and hope help you grow in chat mode.',
    summary: 'Curiosity and hope help Floki grow in chat mode.',
    tags: ['hope', 'curiosity', 'growth'],
    importance: 0.9,
    emotion: {
      hope: 0.8,
      curiosity: 0.7,
      valence: 0.4
    },
    category: 'hopes'
  });

  assert.equal(short.stream, 'short_term');
  assert.equal(short.tags.includes('short_term'), true);
  assert.equal(short.tags.includes('chat'), true);
  assert.equal(short.importance, 0.9);

  const long = substrate.rememberLongTerm({
    category: 'beliefs',
    text: 'Floki believes repeated trustworthy conversations should shape durable memory.',
    summary: 'Trustworthy repeated conversations should shape durable memory.',
    tags: ['belief', 'trust'],
    importance: 0.8,
    emotion: {
      trust: 0.6,
      confidence: 0.4
    }
  });

  assert.equal(long.stream, 'long_term');
  assert.equal(long.category, 'beliefs');
  assert.equal(long.tags.includes('long_term'), true);

  const reinforcement = substrate.reinforce({
    target_type: 'belief',
    target_key: 'trustworthy_conversations_shape_memory',
    signal: 0.4,
    reason: 'A trusted chat memory should strengthen a useful belief.',
    emotion: {
      trust: 0.3,
      hope: 0.2
    }
  });

  assert.equal(reinforcement.event.target_id, 'belief:trustworthy_conversations_shape_memory');
  assert.equal(reinforcement.event.resulting_score > 0, true);
  assert.equal(reinforcement.emotional_state.targets['belief:trustworthy_conversations_shape_memory'].evidence_count, 1);

  const consolidation = substrate.consolidate({
    min_importance: 0.65
  });

  assert.equal(consolidation.promoted_count >= 1, true);
  assert.equal(consolidation.promoted[0].stream, 'long_term');
  assert.equal(consolidation.promoted[0].consolidated_from.includes(short.id), true);

  const recall = substrate.recallContext({
    text: 'hope curiosity trustworthy conversations memory',
    limit: 5
  });

  assert.equal(recall.ok, true);
  assert.equal(recall.marker, 'FLOKI_V2_CHAT_MEMORY_RECALL_CONTEXT_READY');
  assert.equal(recall.persistent_short_term_memory, true);
  assert.equal(recall.persistent_long_term_memory, true);
  assert.equal(recall.emotional_scoring_available, true);
  assert.equal(recall.recall_ready_for_cognition, true);
  assert.equal(recall.short_term_matches.length >= 1, true);
  assert.equal(recall.long_term_matches.length >= 1, true);

  const status = substrate.status();
  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_MEMORY_SUBSTRATE_PASS');
  assert.equal(status.short_term_count >= 1, true);
  assert.equal(status.long_term_count >= 2, true);
  assert.equal(status.emotional_target_count >= 1, true);
  assert.equal(status.memory_consolidation_available, true);
  assert.equal(status.emotional_reinforcement_available, true);
  assert.equal(status.recall_context_available, true);
  assert.equal(status.chat_mode_only, true);

  const proofUnique = newId('chat_memory_proof').replace(/[^a-z0-9_]/g, '_');
  const proof = runChatMemorySubstrateProof({
    base_dir: statePath('test/chat-memory-substrate/' + proofUnique)
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.marker, 'FLOKI_V2_CHAT_MEMORY_SUBSTRATE_PASS');
  assert.equal(proof.persistent_short_term_memory, true);
  assert.equal(proof.persistent_long_term_memory, true);
  assert.equal(proof.emotional_reinforcement_available, true);
  assert.equal(proof.proof_promoted_count >= 1, true);
  assert.equal(proof.proof_recall_long_matches >= 1, true);

  console.log(JSON.stringify(proof, null, 2));
}

run();
