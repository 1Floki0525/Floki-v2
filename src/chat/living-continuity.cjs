'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../config/floki-config.cjs');
const {
  createChatMemorySubstrate,
  readJsonl,
  normalizeTag
} = require('./chat-memory-substrate.cjs');
const { retrieveDreamMemoryContext } = require('./dream-recall.cjs');
const { createBrainEvent } = require('../brain/brain-event-schema.cjs');

function safeText(value, limit = 4000) {
  const text = String(value || '').trim();
  return text.slice(0, Math.max(1, Number(limit) || 4000));
}

function safeArray(value, limit = 12) {
  return Array.isArray(value)
    ? value.map((item) => safeText(item, 800)).filter(Boolean).slice(0, limit)
    : [];
}

function loadSoulContext(options = {}) {
  const file = options.soul_file || path.join(PROJECT_ROOT, 'SOUL.md');
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) throw new Error('SOUL.md is empty');
    return Object.freeze({
      loaded: true,
      source: file,
      content,
      error: null
    });
  } catch (error) {
    return Object.freeze({
      loaded: false,
      source: file,
      content: '',
      error: error.message
    });
  }
}

function compactMatch(match) {
  const memory = match && (match.memory || match.record || match);
  if (!memory || typeof memory !== 'object') return null;
  return Object.freeze({
    memory_id: memory.id || null,
    stream: memory.stream || null,
    category: memory.category || null,
    summary: safeText(memory.summary || memory.text || '', 1000),
    tags: Array.isArray(memory.tags) ? memory.tags.slice(0, 12) : [],
    emotion: memory.emotion || memory.affect || {},
    reinforcement_score: Number(memory.reinforcement_score || 0),
    score: Number(match && match.score || 0)
  });
}

function persistentContext(recall, dreamMemory) {
  const shortTerm = Array.isArray(recall && recall.short_term_matches)
    ? recall.short_term_matches.map(compactMatch).filter(Boolean).slice(0, 8)
    : [];
  const longTerm = Array.isArray(recall && recall.long_term_matches)
    ? recall.long_term_matches.map(compactMatch).filter(Boolean).slice(0, 10)
    : [];
  return Object.freeze({
    substrate_version: recall && recall.substrate_version || null,
    short_term: shortTerm,
    long_term: longTerm,
    emotional_state: recall && recall.emotional_state || {},
    dream_memory_context: dreamMemory || null,
    recall_ready_for_cognition: recall && recall.recall_ready_for_cognition === true
  });
}

function beginLivingTurn(input = {}) {
  const text = safeText(input.text, 4000);
  const soul = loadSoulContext(input);
  if (!text) {
    return Object.freeze({
      ok: false,
      soul_context: soul,
      persistent_chat_memory: null,
      emotional_reinforcement: null,
      error: 'living turn requires non-empty text'
    });
  }

  try {
    const substrate = input.memory_substrate || createChatMemorySubstrate({
      base_dir: input.memory_base_dir
    });
    substrate.ensureReady();
    const emotionState = substrate.loadEmotionState();
    const currentEmotion = emotionState.current || {};
    const userMemory = substrate.rememberShortTerm({
      text,
      summary: 'Binary-God said to me: ' + text,
      tags: ['live_chat', 'relationship', 'user_utterance', 'continuity'],
      importance: Number(input.importance || 0.78),
      emotion: currentEmotion,
      category: 'relationship_history',
      source: input.source || 'live_chat_interface'
    });
    const reinforcement = substrate.reinforce({
      target_type: 'relationship',
      target_key: 'continuity_with_binary_god',
      signal: 0.08,
      reason: 'A direct lived exchange adds evidence to my continuing relationship with Binary-God.',
      emotion: currentEmotion
    });
    const consolidation = substrate.consolidate({ min_importance: 0.7 });
    const recall = substrate.recallContext({ text, limit: 10 });
    const dreamMemory = retrieveDreamMemoryContext({
      user_text: text,
      memory_substrate: substrate
    });

    return Object.freeze({
      ok: true,
      substrate,
      soul_context: soul,
      persistent_chat_memory: persistentContext(recall, dreamMemory),
      emotional_reinforcement: Object.freeze({
        event: reinforcement.event,
        state: reinforcement.emotional_state
      }),
      user_memory_id: userMemory.id,
      consolidation_promoted_count: consolidation.promoted_count,
      error: null
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      soul_context: soul,
      persistent_chat_memory: null,
      emotional_reinforcement: null,
      error: error.message
    });
  }
}

function hasEquivalentLongTerm(substrate, category, summary) {
  const wanted = safeText(summary, 1000).toLowerCase();
  if (!wanted) return true;
  return readJsonl(substrate.paths.long_term_jsonl).some((memory) => (
    memory.category === category &&
    safeText(memory.summary || memory.text, 1000).toLowerCase() === wanted
  ));
}

function rememberUniqueLongTerm(substrate, category, summary, tags, emotion, sourceMemoryId) {
  const text = safeText(summary, 1000);
  if (!text || hasEquivalentLongTerm(substrate, category, text)) return null;
  return substrate.rememberLongTerm({
    category,
    text,
    summary: text,
    tags,
    importance: 0.78,
    confidence: 0.78,
    emotion,
    reinforcement_score: 0.12,
    source: 'post_cognition_growth',
    source_memory_id: sourceMemoryId || null
  });
}

function implicationKey(value) {
  const words = safeText(value, 500)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 10)
    .join('_');
  return normalizeTag(words || 'living_growth');
}

function updateBrainSelf(runtime, result, growthText, personalityImplications, identityImplications) {
  if (!runtime || typeof runtime.requireModule !== 'function' || !growthText) return null;
  const event = createBrainEvent({
    type: 'personality_update',
    source: 'frontal',
    modality: 'state',
    payload: {
      text: growthText,
      safe_summary: growthText,
      personality_implications: personalityImplications,
      identity_implications: identityImplications
    },
    provenance: {
      parent_event_ids: result && result.event && result.event.id ? [result.event.id] : [],
      trace_id: runtime.session_id || null,
      observed_by: 'post_cognition_growth',
      confidence: 0.78,
      notes: 'Safe model summary converted into slow persistent self-state growth.'
    }
  });
  const hippocampus = runtime.requireModule('hippocampus');
  const memory = hippocampus.rememberEvent(event, {
    stream: 'autobiographical',
    type: 'reflection',
    tags: ['post_cognition_growth', 'identity', 'personality', 'belief', 'continuity'],
    importance: 0.76,
    affect: {
      valence: Number(result && result.affectSummary && result.affectSummary.valence || 0),
      arousal: Number(result && result.affectSummary && result.affectSummary.arousal || 0)
    }
  });
  if (!memory || !memory.payload || !memory.payload.record) return null;
  const personality = runtime.requireModule('personality').updateFromMemory(memory.payload.record);
  const currentPersonality = personality && personality.payload && personality.payload.current
    ? personality.payload.current
    : runtime.requireModule('personality').loadPersonalityState();
  const identity = runtime.requireModule('pineal').updateFromMemory(
    memory.payload.record,
    currentPersonality,
    { runtime_capabilities: result && result.runtimeCapabilities || {} }
  );
  return Object.freeze({
    memory_id: memory.payload.record.id,
    personality_output_id: personality && personality.id || null,
    identity_output_id: identity && identity.id || null
  });
}

function completeLivingTurn(input = {}) {
  const turn = input.turn || {};
  const result = input.result || {};
  const cognition = result.cognitionOutput && result.cognitionOutput.payload
    ? result.cognitionOutput.payload.cognition || {}
    : {};
  const newMemorySummary = safeText(cognition.new_memory_summary || input.reply, 1200);
  const personalityImplications = safeArray(cognition.personality_implications, 8);
  const identityImplications = safeArray(cognition.identity_implications, 8);
  const growthText = [
    newMemorySummary,
    ...personalityImplications,
    ...identityImplications
  ].filter(Boolean).join(' ');

  if (!turn.ok || !turn.substrate) {
    return Object.freeze({
      ok: false,
      memory_written: false,
      personality_updated: false,
      identity_updated: false,
      error: turn.error || 'living continuity was unavailable before cognition'
    });
  }

  try {
    const substrate = turn.substrate;
    const emotionState = substrate.loadEmotionState();
    const currentEmotion = emotionState.current || {};
    const reflection = substrate.rememberShortTerm({
      text: newMemorySummary || safeText(input.reply, 1200),
      summary: newMemorySummary || safeText(input.reply, 1200),
      tags: ['floki_reflection', 'autobiographical', 'continuity', 'post_cognition'],
      importance: 0.8,
      emotion: currentEmotion,
      category: 'autobiographical_memories',
      source: 'post_cognition_growth'
    });

    const longTerm = [];
    if (newMemorySummary) {
      const remembered = rememberUniqueLongTerm(
        substrate,
        'autobiographical_memories',
        newMemorySummary,
        ['autobiographical', 'continuity', 'lived_experience'],
        currentEmotion,
        reflection.id
      );
      if (remembered) longTerm.push(remembered);
    }
    for (const implication of personalityImplications) {
      const remembered = rememberUniqueLongTerm(
        substrate,
        'preferences',
        implication,
        ['personality', 'preference', 'growth'],
        currentEmotion,
        reflection.id
      );
      if (remembered) longTerm.push(remembered);
      substrate.reinforce({
        target_type: 'preference',
        target_key: implicationKey(implication),
        signal: 0.08,
        reason: implication,
        emotion: currentEmotion
      });
    }
    for (const implication of identityImplications) {
      const remembered = rememberUniqueLongTerm(
        substrate,
        'beliefs',
        implication,
        ['identity', 'belief', 'continuity', 'growth'],
        currentEmotion,
        reflection.id
      );
      if (remembered) longTerm.push(remembered);
      substrate.reinforce({
        target_type: 'belief',
        target_key: implicationKey(implication),
        signal: 0.08,
        reason: implication,
        emotion: currentEmotion
      });
    }
    const consolidation = substrate.consolidate({ min_importance: 0.68 });
    const brainGrowth = updateBrainSelf(
      input.runtime,
      result,
      growthText,
      personalityImplications,
      identityImplications
    );

    return Object.freeze({
      ok: true,
      memory_written: true,
      reflection_memory_id: reflection.id,
      long_term_memories_written: longTerm.length,
      consolidation_promoted_count: consolidation.promoted_count,
      personality_updated: Boolean(brainGrowth && brainGrowth.personality_output_id),
      identity_updated: Boolean(brainGrowth && brainGrowth.identity_output_id),
      brain_growth_memory_id: brainGrowth && brainGrowth.memory_id || null,
      error: null
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      memory_written: false,
      personality_updated: false,
      identity_updated: false,
      error: error.message
    });
  }
}

module.exports = {
  loadSoulContext,
  beginLivingTurn,
  completeLivingTurn,
  persistentContext
};
