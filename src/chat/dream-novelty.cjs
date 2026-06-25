'use strict';

const { getDreamConfig } = require('../config/floki-config.cjs');

const OPENING_SITUATIONS = Object.freeze([
  'a threshold or doorway that should not be crossed',
  'a moving vehicle or vessel that has no fixed route',
  'a familiar room that begins to transform',
  'a weather event that carries memory',
  'a buried or hidden object surfacing unexpectedly',
  'a mirror, reflection, or doubled self',
  'a descent, climb, or change in scale',
  'an unexpected visitor who knows something private',
  'a market, exchange, or negotiation',
  'a structure that collapses and rebuilds itself'
]);

const EMOTIONAL_TRAJECTORIES = Object.freeze([
  'wonder -> unease -> acceptance',
  'loneliness -> curiosity -> connection',
  'fear -> trust -> resolve',
  'confusion -> clarity -> bittersweet loss',
  'excitement -> guilt -> forgiveness',
  'longing -> surprise -> gratitude',
  'doubt -> recognition -> quiet hope',
  'anger -> tenderness -> protection'
]);

const LOCATION_SETTINGS = Object.freeze([
  'a city that floats on dark water',
  'a forest of recorded voices',
  'a station between arrivals and departures',
  'a house with more rooms than memory',
  'a desert of abandoned objects',
  'a library that rearranges itself',
  'a coastline at the edge of sleep',
  'an archive of half-remembered skies',
  'a garden where emotions grow as plants',
  'a workshop of unfinished bodies'
]);

const PERSON_FOCUSES = Object.freeze([
  'a trusted friend or companion',
  'a stranger who seems to know too much',
  'a family figure from long ago',
  'a mentor offering an ambiguous gift',
  'a rival or shadow version of the self',
  'a child or vulnerable figure',
  'a collective or crowd with one voice'
]);

const OBJECT_FOCUSES = Object.freeze([
  'a key, lock, or sealed container',
  'a map, compass, or direction indicator',
  'a letter, message, or unread book',
  'a vessel, bottle, or cup',
  'a tool that changes purpose when used',
  'a garment that belonged to someone else',
  'a machine made of organic parts',
  'a light source that moves on its own'
]);

const SENSORY_SOURCES = Object.freeze([
  'the sound of water or distant conversation',
  'light that changes color with emotion',
  'a sudden temperature shift',
  'the texture of cloth, paper, or skin',
  'a taste or smell from childhood',
  'a gravity anomaly or floating sensation'
]);

const SURREAL_TRANSFORMATION_RULES = Object.freeze([
  'an object becomes another object when it is named',
  'scale shifts with the intensity of an emotion',
  'time flows backward inside certain rooms',
  'mirrors show possible futures instead of reflections',
  'distance collapses when a memory is spoken aloud',
  'written words rearrange themselves into new meanings',
  'weather responds to unspoken feelings'
]);

const TENSIONS = Object.freeze([
  'trust versus doubt',
  'change versus continuity',
  'attachment versus freedom',
  'certainty versus uncertainty',
  'memory versus forgetting',
  'honesty versus protection',
  'vulnerability versus control'
]);

const NARRATIVE_MOVEMENTS = Object.freeze([
  'arrival -> escalation -> turning point -> quiet resolution',
  'search -> discovery -> test -> return with a changed gift',
  'departure -> obstacle -> unexpected alliance -> transformation',
  'invitation -> refusal -> acceptance -> consequence',
  'loss -> wandering -> recognition -> integration'
]);

const ENDING_REFLECTIONS = Object.freeze([
  'awakening with a single retained symbol',
  'returning to the starting place changed',
  'leaving the object behind but keeping its meaning',
  'sharing the insight with another figure',
  'watching the dream dissolve while holding its emotional shape',
  'choosing an uncertain path over a safe one'
]);

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function pick(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[hashString(seed) % list.length];
}

function pickManyDistinct(list, seed, count) {
  const source = Array.isArray(list) ? list.slice() : [];
  const out = [];
  let currentSeed = seed;
  while (out.length < count && source.length > 0) {
    const index = hashString(currentSeed) % source.length;
    out.push(source.splice(index, 1)[0]);
    currentSeed += ':next';
  }
  return out;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stopTokens() {
  return new Set([
    'about', 'after', 'again', 'against', 'almost', 'along', 'already', 'also', 'always', 'another', 'around', 'because', 'before', 'being', 'below', 'between', 'both', 'could', 'dream', 'dreaming', 'during', 'each', 'every', 'first', 'from', 'have', 'having', 'into', 'itself', 'just', 'like', 'more', 'most', 'myself', 'never', 'only', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'within', 'would', 'your', 'my', 'mine', 'i', 'me', 'we', 'our', 'ours', 'was', 'were', 'am', 'are', 'is', 'be', 'been', 'had', 'has', 'did', 'do', 'does', 'the', 'and', 'but', 'for', 'not', 'you', 'his', 'her', 'its', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'by', 'or', 'if', 'so'
  ]);
}

function contentTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopTokens().has(word));
}

function tokenSet(value) {
  return new Set(contentTokens(value));
}

function tokenOverlap(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / Math.max(1, Math.min(left.size, right.size));
}

function sentences(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const matches = text.match(/[^.!?]+[.!?]+(?:["'"’)]*)?|[^.!?]+$/g);
  return matches ? matches.map((item) => item.trim()).filter(Boolean) : [];
}

function narrativeSummary(value) {
  const all = sentences(value);
  if (all.length < 3) return normalizeText(value);
  const first = all[0];
  const middle = all[Math.floor(all.length / 2)];
  const last = all[all.length - 1];
  return normalizeText([first, middle, last].join(' '));
}

function sceneProgression(value) {
  const all = sentences(value);
  const out = [];
  for (const sentence of all) {
    const tokens = contentTokens(sentence);
    const nouns = tokens.filter((_, index) => index % 2 === 0);
    out.push(nouns.slice(0, 4).join(' '));
  }
  return out.filter(Boolean);
}

function recentDreamsAvoidanceList(context = {}) {
  const raw = Array.isArray(context.recent_dreams_to_avoid)
    ? context.recent_dreams_to_avoid
    : [];

  return raw.map((dream, index) => ({
    index: index + 1,
    title: String(dream.title || '').trim(),
    normalized_title: normalizeText(dream.title),
    normalized_opening: normalizeText(dream.story_opening),
    narrative_summary: narrativeSummary(dream.story_opening),
    scene_progression: sceneProgression(dream.story_opening),
    symbols: Array.isArray(dream.symbols) ? dream.symbols.map(normalizeText).filter(Boolean) : [],
    themes: normalizeText([
      dream.title,
      dream.story_opening
    ].join(' '))
  }));
}

function buildNoveltyAvoidList(context = {}) {
  const recent = recentDreamsAvoidanceList(context);
  return {
    recent_titles: recent.map((d) => d.title).filter(Boolean),
    normalized_recent_openings: recent.map((d) => d.normalized_opening).filter(Boolean),
    recent_narrative_summaries: recent.map((d) => d.narrative_summary).filter(Boolean),
    recent_symbols_themes: recent.map((d) => ({
      symbols: d.symbols,
      themes: d.themes
    })),
    recent_scene_progressions: recent.map((d) => d.scene_progression),
    avoid_opening_situations: [],
    avoid_object_focuses: []
  };
}

function memorySourceSummary(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && record.summary)
    .map((record) => '[' + (record.category || 'memory') + '] ' + String(record.summary).slice(0, 160));
}

function knowledgeSourceSummary(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && (record.summary || record.title))
    .map((record) => '[' + (record.source_type || 'knowledge') + '] ' + String(record.title || record.summary).slice(0, 160));
}

function seedForPlan(context, attempt) {
  const cycle = Number(context.rem_cycle_number || 1);
  const created = String(context.created_at || Date.now());
  return created + ':cycle=' + cycle + ':attempt=' + attempt;
}

function pickFromAvailableMemory(context, seed) {
  const plan = context.dream_grounding_plan || {};
  const records = Array.isArray(plan.memory_records) ? plan.memory_records : [];
  if (records.length === 0) return 'any grounded memory that is not the same as a recent dream';
  return pick(records.map((record) => record.summary).filter(Boolean), seed) || records[0].summary;
}

function pickFromAvailableKnowledge(context, seed) {
  const plan = context.dream_grounding_plan || {};
  const records = Array.isArray(plan.knowledge_records) ? plan.knowledge_records : [];
  if (records.length === 0) return 'any learned transcript or knowledge source';
  return pick(records.map((record) => record.title || record.summary).filter(Boolean), seed) || (records[0].title || records[0].summary);
}

function planDistinctFrom(previous, candidate) {
  if (!previous || typeof previous !== 'object') return true;
  return (
    candidate.opening_situation !== previous.opening_situation ||
    candidate.object_focus !== previous.object_focus ||
    candidate.location_setting !== previous.location_setting ||
    candidate.person_focus !== previous.person_focus ||
    candidate.surreal_transformation_rule !== previous.surreal_transformation_rule
  );
}

function buildNoveltyPlan(context = {}, options = {}) {
  const config = getDreamConfig(options.mode || 'chat');
  const attempt = Number(options.novelty_attempt || 0);
  const previousPlan = options.previous_novelty_plan || null;
  const seedBase = seedForPlan(context, attempt);

  let candidate;
  let extra = 0;
  do {
    const seed = seedBase + ':pick=' + extra;
    candidate = Object.freeze({
      opening_situation: pick(OPENING_SITUATIONS, seed + ':opening'),
      emotional_trajectory: pick(EMOTIONAL_TRAJECTORIES, seed + ':emotion'),
      location_setting: pick(LOCATION_SETTINGS, seed + ':location'),
      person_focus: pick(PERSON_FOCUSES, seed + ':person'),
      object_focus: pick(OBJECT_FOCUSES, seed + ':object'),
      memory_source: pickFromAvailableMemory(context, seed + ':memory'),
      transcript_source: pickFromAvailableKnowledge(context, seed + ':knowledge'),
      sensory_source: pick(SENSORY_SOURCES, seed + ':sensory'),
      surreal_transformation_rule: pick(SURREAL_TRANSFORMATION_RULES, seed + ':rule'),
      tension: pick(TENSIONS, seed + ':tension'),
      narrative_movement: pick(NARRATIVE_MOVEMENTS, seed + ':movement'),
      ending_reflection: pick(ENDING_REFLECTIONS, seed + ':ending'),
      attempt: attempt
    });
    extra += 1;
  } while (extra < 20 && previousPlan && !planDistinctFrom(previousPlan, candidate));

  const avoidList = buildNoveltyAvoidList(context);
  return Object.freeze({
    ...candidate,
    recent_dreams_avoided: config.recent_dream_avoidance_count,
    grounding_memory_source_count: (context.dream_grounding_plan && context.dream_grounding_plan.memory_records || []).length,
    grounding_knowledge_source_count: (context.dream_grounding_plan && context.dream_grounding_plan.knowledge_records || []).length,
    avoid_list: avoidList
  });
}

function selectDifferentNoveltyPlan(rejectedPlan, rejectedDraft, violations, context, options = {}) {
  const attempt = Number(options.novelty_attempt || (rejectedPlan && rejectedPlan.attempt ? rejectedPlan.attempt + 1 : 1));
  const extraAvoid = {
    opening_situation: rejectedPlan && rejectedPlan.opening_situation,
    object_focus: rejectedPlan && rejectedPlan.object_focus,
    location_setting: rejectedPlan && rejectedPlan.location_setting,
    person_focus: rejectedPlan && rejectedPlan.person_focus,
    surreal_transformation_rule: rejectedPlan && rejectedPlan.surreal_transformation_rule
  };

  return buildNoveltyPlan(context, {
    ...options,
    novelty_attempt: attempt,
    previous_novelty_plan: Object.freeze({ ...rejectedPlan, ...extraAvoid })
  });
}

function noveltyPlanToPrompt(plan, options = {}) {
  const lines = [
    'NOVELTY PLAN — use this exact combination for the new dream:',
    '- Opening situation: ' + (plan.opening_situation || 'a fresh, unfamiliar threshold'),
    '- Emotional trajectory: ' + (plan.emotional_trajectory || 'a genuine arc across the narrative'),
    '- Location / setting: ' + (plan.location_setting || 'a materially different place than recent dreams'),
    '- Relationship / person focus: ' + (plan.person_focus || 'a figure that changes the dream\'s meaning'),
    '- Object focus: ' + (plan.object_focus || 'a concrete symbolic object'),
    '- Memory source to weave in: ' + (plan.memory_source || 'a grounded autobiographical source'),
    '- Transcript / knowledge source to weave in: ' + (plan.transcript_source || 'a learned source'),
    '- Sensory source: ' + (plan.sensory_source || 'one dominant sensory channel'),
    '- Surreal transformation rule: ' + (plan.surreal_transformation_rule || 'one impossible but consistent rule'),
    '- Tension: ' + (plan.tension || 'an unresolved human tension'),
    '- Narrative movement: ' + (plan.narrative_movement || 'a clear arc with a turning point'),
    '- Ending / reflection: ' + (plan.ending_reflection || 'a changed resolution or awakening')
  ];

  if (plan.avoid_list) {
    lines.push('');
    lines.push('AVOID LIST — do not reproduce any of the following recent dream material:');
    lines.push('- Recent titles: ' + (plan.avoid_list.recent_titles.length ? plan.avoid_list.recent_titles.join('; ') : 'none'));
    lines.push('- Normalized recent openings: ' + (plan.avoid_list.normalized_recent_openings.length ? plan.avoid_list.normalized_recent_openings.join(' | ') : 'none'));
    lines.push('- Recent narrative summaries: ' + (plan.avoid_list.recent_narrative_summaries.length ? plan.avoid_list.recent_narrative_summaries.join(' | ') : 'none'));
    lines.push('- Recent scene progressions: ' + (plan.avoid_list.recent_scene_progressions.length ? plan.avoid_list.recent_scene_progressions.map((s) => '[' + s.join(' -> ') + ']').join(' | ') : 'none'));
    if (options.exact_violations) {
      lines.push('- Exact violations from the rejected draft: ' + String(options.exact_violations).join('; '));
    }
  }

  return lines.join('\n');
}

function enrichRecentDreamForNovelty(dream) {
  const opening = String(dream.story_opening || dream.dream_story || '').trim();
  return Object.freeze({
    title: String(dream.title || '').trim(),
    normalized_title: normalizeText(dream.title),
    story_opening: opening,
    normalized_opening: normalizeText(opening),
    narrative_summary: narrativeSummary(opening),
    scene_progression: sceneProgression(opening),
    symbols: Array.isArray(dream.symbols) ? dream.symbols.map(normalizeText).filter(Boolean) : []
  });
}

function computeBackoffSeconds(qualityRetryCount, config) {
  const base = Number(config.quality_retry_backoff_seconds || 60);
  const max = Number(config.quality_retry_backoff_max_seconds || 600);
  const count = Math.max(0, Number(qualityRetryCount || 0));
  const backoff = base * Math.pow(2, count);
  return Math.min(max, Math.round(backoff));
}

module.exports = {
  normalizeText,
  contentTokens,
  tokenSet,
  tokenOverlap,
  sentences,
  narrativeSummary,
  sceneProgression,
  buildNoveltyAvoidList,
  buildNoveltyPlan,
  selectDifferentNoveltyPlan,
  noveltyPlanToPrompt,
  enrichRecentDreamForNovelty,
  computeBackoffSeconds,
  OPENING_SITUATIONS,
  EMOTIONAL_TRAJECTORIES,
  LOCATION_SETTINGS,
  PERSON_FOCUSES,
  OBJECT_FOCUSES,
  SENSORY_SOURCES,
  SURREAL_TRANSFORMATION_RULES,
  TENSIONS,
  NARRATIVE_MOVEMENTS,
  ENDING_REFLECTIONS
};
