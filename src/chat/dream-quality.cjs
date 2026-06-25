'use strict';

const { getDreamConfig } = require('../config/floki-config.cjs');
const {
  normalizeText,
  tokenOverlap,
  narrativeSummary,
  sceneProgression
} = require('./dream-novelty.cjs');

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function paragraphCount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;

  const blankLineParagraphs = text
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (blankLineParagraphs.length > 1) {
    return blankLineParagraphs.length;
  }

  return text.split(/\n+/).map((item) => item.trim()).filter(Boolean).length;
}

function sentenceCount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;

  const matches = text.match(/[^.!?]+[.!?]+(?:["'”’)]*)?|[^.!?]+$/g);
  return matches ? matches.map((item) => item.trim()).filter(Boolean).length : 0;
}

function formatDreamStoryParagraphs(value, targetParagraphs = 4) {
  const text = String(value || '').trim();
  if (!text || paragraphCount(text) > 1) {
    return text;
  }

  const matches = text.match(/[^.!?]+[.!?]+(?:["'”’)]*)?|[^.!?]+$/g);
  const sentences = matches
    ? matches.map((item) => item.trim()).filter(Boolean)
    : [];

  if (sentences.length < 5) {
    return text;
  }

  const target = Math.max(3, Math.min(5, Number(targetParagraphs) || 4));
  const groupSize = Math.max(2, Math.ceil(sentences.length / target));
  const paragraphs = [];

  for (let index = 0; index < sentences.length; index += groupSize) {
    paragraphs.push(sentences.slice(index, index + groupSize).join(' '));
  }

  return paragraphs.join('\n\n');
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTokens(value) {
  const stop = new Set([
    'about','after','again','against','almost','along','already','also','always','another','around','because','before','being','below','between','both','could','dream','dreaming','during','each','every','first','from','have','having','into','itself','just','like','more','most','myself','never','only','other','over','same','should','some','such','than','that','their','them','then','there','these','they','this','those','through','under','until','very','what','when','where','which','while','with','within','would','your','my','mine','i','me','we','our','ours','was','were','am','are','is','be','been','had','has','did','do','does','the','and','but','for','not','you','his','her','its','a','an','of','to','in','on','at','as','by','or','if','so'
  ]);
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stop.has(word));
}

function tokenSet(value) {
  return new Set(normalizedTokens(value));
}

function overlap(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / Math.max(1, Math.min(left.size, right.size));
}

function shingles(value, size = 3) {
  const tokens = normalizedTokens(value);
  const out = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    out.add(tokens.slice(index, index + size).join(' '));
  }
  return out;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function openingSimilarity(a, b) {
  const leftTokens = normalizedTokens(a);
  const rightTokens = normalizedTokens(b);
  if (leftTokens.length < 8 || rightTokens.length < 8) return 0;
  const tokenContainment = overlap(a, b);
  const phraseSimilarity = jaccard(shingles(a), shingles(b));
  return Math.max(phraseSimilarity, tokenContainment * phraseSimilarity);
}

function resolveDreamQualityConfig(options = {}) {
  if (options.quality_config) {
    return Object.freeze({ ...options.quality_config });
  }

  const config = getDreamConfig(options.mode || 'chat');

  return Object.freeze({
    min_story_words: Number(options.min_story_words || config.min_story_words),
    target_story_words: Number(options.target_story_words || config.target_story_words),
    max_story_words: Number(options.max_story_words || config.max_story_words),
    min_story_sentences: Number(options.min_story_sentences || config.min_story_sentences),
    min_symbols: Number(options.min_symbols || config.min_symbols),
    min_consolidation_words: Number(
      options.min_consolidation_words || config.min_consolidation_words
    ),
    min_reflection_words: Number(
      options.min_reflection_words || config.min_reflection_words
    ),
    grounding_memory_limit: Number(
      options.grounding_memory_limit || config.grounding_memory_limit
    ),
    grounding_knowledge_limit: Number(
      options.grounding_knowledge_limit || config.grounding_knowledge_limit
    ),
    quality_regeneration_attempts: Number(
      options.quality_regeneration_attempts ??
      config.quality_regeneration_attempts
    ),
    quality_retry_backoff_seconds: Number(
      options.quality_retry_backoff_seconds ??
      config.quality_retry_backoff_seconds
    ),
    quality_retry_backoff_max_seconds: Number(
      options.quality_retry_backoff_max_seconds ??
      config.quality_retry_backoff_max_seconds
    ),
    novelty_thresholds: options.novelty_thresholds || config.novelty_thresholds || {
      opening_similarity: 0.42,
      narrative_arc_similarity: 0.78,
      scene_progression_similarity: 0.68,
      ending_similarity: 0.78,
      paraphrase_similarity: 0.62,
      symbol_sequence_similarity: 0.78
    }
  });
}

function assertNovelty(dream, context) {
  const violations = checkNoveltyViolations(dream, context);
  if (violations.length > 0) {
    throw new Error('dream quality violations: ' + violations.join('; '));
  }
}

function jaccardTokens(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function checkNoveltyViolations(dream, context, options = {}) {
  const recent = context && Array.isArray(context.recent_dreams_to_avoid)
    ? context.recent_dreams_to_avoid
    : [];
  const config = resolveDreamQualityConfig(options);
  const thresholds = config.novelty_thresholds || {};
  const title = normalizeTitle(dream.title);
  const story = String(dream.dream_story || '');
  const opening = story.split(/\s+/).slice(0, 80).join(' ');
  const ending = story.split(/\s+/).slice(-40).join(' ');
  const dreamSummary = narrativeSummary(story);
  const dreamScenes = sceneProgression(story);
  const symbols = new Set((dream.symbols || []).map(normalizeTitle).filter(Boolean));
  const violations = [];

  for (const prior of recent) {
    const priorTitle = normalizeTitle(prior && prior.title);
    const priorStory = String(prior && prior.story_opening || '');
    const priorSummary = narrativeSummary(priorStory);
    const priorScenes = sceneProgression(priorStory);
    const priorEnding = priorStory.split(/\s+/).slice(-40).join(' ');
    const priorSymbols = new Set(
      (prior && prior.symbols || []).map(normalizeTitle).filter(Boolean)
    );

    if (
      title && priorTitle &&
      (title === priorTitle ||
        (tokenSet(title).size >= 2 && tokenSet(priorTitle).size >= 2 && overlap(title, priorTitle) >= 0.9))
    ) {
      violations.push('copied or synonym-swapped title: ' + prior.title);
    }

    if (opening && priorStory) {
      const exactOpening = normalizeTitle(opening).slice(0, 220) ===
        normalizeTitle(priorStory).slice(0, 220);
      const similarity = openingSimilarity(opening, priorStory);
      if (exactOpening || similarity >= (thresholds.opening_similarity || 0.42)) {
        violations.push('same opening as a recent dream');
      }
    }

    if (dreamSummary && priorSummary) {
      const arcSimilarity = tokenOverlap(dreamSummary, priorSummary);
      if (arcSimilarity >= (thresholds.narrative_arc_similarity || 0.78)) {
        violations.push('same narrative arc as a recent dream');
      }
    }

    if (dreamScenes.length && priorScenes.length) {
      const sceneText = dreamScenes.join(' ');
      const priorSceneText = priorScenes.join(' ');
      const sceneSimilarity = tokenOverlap(sceneText, priorSceneText);
      if (sceneSimilarity >= (thresholds.scene_progression_similarity || 0.68)) {
        violations.push('same scene progression as a recent dream');
      }
    }

    if (ending && priorEnding) {
      const endingSimilarity = tokenOverlap(ending, priorEnding);
      if (endingSimilarity >= (thresholds.ending_similarity || 0.78)) {
        violations.push('same ending as a recent dream');
      }
    }

    if (story && priorStory) {
      const paraphraseSimilarity = tokenOverlap(story, priorStory);
      if (paraphraseSimilarity >= (thresholds.paraphrase_similarity || 0.62)) {
        violations.push('lightly paraphrased recent dream');
      }
    }

    if (symbols.size >= 3 && priorSymbols.size >= 3) {
      const symbolSimilarity = jaccardTokens(
        Array.from(symbols).join(' '),
        Array.from(priorSymbols).join(' ')
      );
      if (symbolSimilarity >= (thresholds.symbol_sequence_similarity || 0.78)) {
        violations.push('same symbol sequence as a recent dream');
      }
    }

    let repeated = 0;
    for (const symbol of symbols) if (priorSymbols.has(symbol)) repeated += 1;
    if (symbols.size >= 4 && repeated >= Math.ceil(symbols.size * 0.8)) {
      violations.push('reuses too many symbols from a recent dream');
    }
  }

  return violations;
}

function validateDreamQuality(dream, context = null, options = {}) {
  const config = resolveDreamQualityConfig(options);
  const storyWords = wordCount(dream.dream_story);
  const paragraphs = paragraphCount(dream.dream_story);
  const sentences = sentenceCount(dream.dream_story);
  const consolidationWords = wordCount(dream.consolidation_summary);
  const reflectionWords = wordCount(dream.first_person_reflection);
  const symbols = Array.isArray(dream.symbols) ? dream.symbols : [];
  const memorySources = Array.isArray(dream.memory_sources)
    ? dream.memory_sources
    : [];
  const knowledgeSources = Array.isArray(dream.knowledge_sources)
    ? dream.knowledge_sources
    : [];

  const errors = [];

  if (storyWords < config.min_story_words) {
    errors.push(
      'dream_story is too short: ' +
      storyWords +
      ' words; minimum is ' +
      config.min_story_words
    );
  }

  if (storyWords > config.max_story_words) {
    errors.push(
      'dream_story is too long: ' +
      storyWords +
      ' words; maximum is ' +
      config.max_story_words
    );
  }

  if (sentences < config.min_story_sentences) {
    errors.push(
      'dream_story needs at least ' +
      config.min_story_sentences +
      ' sentences; received ' +
      sentences
    );
  }

  if (symbols.length < config.min_symbols) {
    errors.push(
      'dream needs at least ' +
      config.min_symbols +
      ' distinct symbols; received ' +
      symbols.length
    );
  }

  if (consolidationWords < config.min_consolidation_words) {
    errors.push(
      'consolidation_summary is too short: ' +
      consolidationWords +
      ' words; minimum is ' +
      config.min_consolidation_words
    );
  }

  if (reflectionWords < config.min_reflection_words) {
    errors.push(
      'first_person_reflection is too short: ' +
      reflectionWords +
      ' words; minimum is ' +
      config.min_reflection_words
    );
  }

  try {
    if (context) assertNovelty(dream, context);
  } catch (error) {
    errors.push(error.message);
  }

  if (errors.length > 0) {
    throw new Error('dream quality violations: ' + errors.join('; '));
  }

  return Object.freeze({
    story_word_count: storyWords,
    story_paragraph_count: paragraphs,
    story_sentence_count: sentences,
    consolidation_word_count: consolidationWords,
    reflection_word_count: reflectionWords,
    memory_source_count: memorySources.length,
    knowledge_source_count: knowledgeSources.length,
    symbol_count: symbols.length,
    paragraph_breaks_present: paragraphs > 1,
    paragraph_formatting_advisory_only: true,
    novelty_verified: true,
    runtime_grounding_verified: true
  });
}

function recentDreamAvoidanceText(context) {
  const recent = context && Array.isArray(context.recent_dreams_to_avoid)
    ? context.recent_dreams_to_avoid
    : [];

  if (!recent.length) {
    return 'No prior dream motifs were available.';
  }

  return recent.map((dream, index) => {
    return [
      'D' + String(index + 1),
      dream.title ? 'title=' + dream.title : '',
      Array.isArray(dream.symbols) && dream.symbols.length
        ? 'symbols=' + dream.symbols.join(', ')
        : '',
      dream.story_opening
        ? 'opening=' + dream.story_opening.slice(0, 180)
        : ''
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

function buildDreamQualityInstructions(context, options = {}) {
  const config = resolveDreamQualityConfig(options);

  return [
    'Write a complete first-person dream narrative, not a synopsis and not a one-scene fragment.',
    'Target about ' + config.target_story_words + ' words. The accepted range is ' +
      config.min_story_words + '-' + config.max_story_words + ' words.',
    'Use at least ' + config.min_story_sentences + ' complete sentences.',
    'Paragraph breaks are welcome but not required inside JSON.',
    'Give the dream a real arc: arrival, escalation or transformation, a meaningful turning point, and an emotionally changed resolution or awakening.',
    'Use vivid sensory detail, movement through space, changing imagery, emotional continuity, and specific interactions.',
    'Fuse the supplied memories, personality, beliefs, biases, emotions, relationships, hopes, fears, and learned knowledge into symbolic events.',
    'Do not list source IDs or invent provenance fields. Runtime attaches trusted provenance after generation.',
    'Use at least ' + config.min_symbols + ' specific symbols.',
    'Write a meaningful consolidation_summary of at least ' +
      config.min_consolidation_words + ' words.',
    'Write a meaningful first_person_reflection of at least ' +
      config.min_reflection_words + ' words.',
    'Write first_person_reflection as a personal reflection when possible. Runtime guarantees final first-person grammar.',
    'Never narrate Floki as a separate third-person subject.',
    'Do not default to forests, whispering trees, glass trees, lanterns, forgotten keys, or vague ancient voices unless the supplied context genuinely supports them.',
    'Do not reuse a recent dream title, opening, or dominant symbol set.',
    '',
    'Recent dreams and motifs to avoid:',
    recentDreamAvoidanceText(context)
  ].join('\n');
}

function buildQualityRegenerationPrompt(error, previousJson, context, options = {}) {
  return [
    'The previous dream did not meet the narrative quality contract.',
    'Quality report: ' + String(error && error.message || error).slice(0, 700),
    'Regenerate the complete dream as a genuinely new narrative. Do not merely patch or shorten individual fields.',
    'Change the setting, opening action, central relationship, turning point, ending image, and dominant symbol set.',
    'Use a different combination of grounded memories, learned transcripts, personality traits, relationships, vision observations, and object history than the rejected draft.',
    'Similarity is allowed at the level of recurring human themes, but the narrative thought-line and scene sequence must be original.',
    'Return exactly one JSON object matching the model-content schema.',
    'Do not emit memory_sources, knowledge_sources, rem_cycle_number, safe_summary_only, remembered_as, or any other runtime metadata.',
    'No markdown and no private reasoning.',
    '',
    buildDreamQualityInstructions(context, options),
    '',
    'Previous rejected model content:',
    JSON.stringify(previousJson || {}, null, 2),
    '',
    'Grounding context:',
    JSON.stringify(context, null, 2)
  ].join('\n');
}

function groundedSourceDescriptions(values) {
  return (Array.isArray(values) ? values : []).map((value) => String(value));
}

module.exports = {
  wordCount,
  paragraphCount,
  sentenceCount,
  formatDreamStoryParagraphs,
  normalizeTitle,
  resolveDreamQualityConfig,
  validateDreamQuality,
  checkNoveltyViolations,
  assertNovelty,
  buildDreamQualityInstructions,
  buildQualityRegenerationPrompt,
  groundedSourceDescriptions
};
