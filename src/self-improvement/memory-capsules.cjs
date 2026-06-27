'use strict';

// Compact, task-relevant memory capsules for the RSI harness.
//
// Personal continuity (identity, beliefs, values, relationships, experiences,
// dreams, preferences, Maker interactions) and engineering memory (failure
// signatures, root causes, repair patterns, config transport paths, approved
// candidates, denial requirements, test behavior, tool-use lessons, repository
// architecture) are retrieved SEPARATELY and bounded — never the whole memory
// bank injected into every cycle. All limits originate in chat YAML.

const fs = require('node:fs');
const path = require('node:path');

const { loadSelfImprovementConfig } = require('./config.cjs');
const store = require('./store.cjs');
const repoIntel = require('./repo-intelligence.cjs');

function splitPipeList(value) {
  if (typeof value !== 'string') return [];
  return value.split('|').map((s) => s.trim()).filter(Boolean);
}

function relevanceScore(text, signalTokens) {
  if (signalTokens.length === 0) return 0;
  const lower = String(text || '').toLowerCase();
  let score = 0;
  for (const token of signalTokens) if (token && lower.includes(token)) score += 1;
  return score;
}

function signalTokensFrom(signals) {
  let text;
  if (Array.isArray(signals)) text = signals.join(' ');
  else if (signals && typeof signals === 'object') text = Object.values(signals).join(' ');
  else text = String(signals || '');
  return text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
}

function readBoundedExcerpt(absPath, maxChars) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

// Collect bounded items from a configured source (file or directory) ordered by
// relevance to the task signals.
function collectFromSources(sources, projectRoot, signalTokens, config) {
  const itemMax = config.memory_capsule_item_max_chars;
  const perSection = config.memory_capsule_max_items_per_section;
  const items = [];
  for (const rel of sources) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const excerpt = readBoundedExcerpt(abs, itemMax);
      if (excerpt) items.push({ source: rel, excerpt, score: relevanceScore(excerpt, signalTokens) });
    } else if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isFile())
          .slice(0, perSection * 2);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const excerpt = readBoundedExcerpt(path.join(abs, entry.name), itemMax);
        if (excerpt) items.push({ source: rel + '/' + entry.name, excerpt, score: relevanceScore(excerpt, signalTokens) });
      }
    }
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, perSection);
}

function enforceTotalBudget(sections, totalMax) {
  let used = 0;
  let truncated = false;
  for (const item of sections) {
    if (used >= totalMax) {
      item.excerpt = '';
      item.dropped = true;
      truncated = true;
      continue;
    }
    if (used + item.excerpt.length > totalMax) {
      item.excerpt = item.excerpt.slice(0, totalMax - used);
      item.truncated = true;
      truncated = true;
    }
    used += item.excerpt.length;
  }
  return { used, truncated };
}

function retrievePersonalCapsule(signals, config = loadSelfImprovementConfig()) {
  const tokens = signalTokensFrom(signals);
  const sources = splitPipeList(config.memory_capsule_personal_sources);
  const items = collectFromSources(sources, config.project_root, tokens, config);
  const budget = enforceTotalBudget(items, config.memory_capsule_total_max_chars);
  return Object.freeze({
    marker: 'FLOKI_V2_RSI_PERSONAL_CAPSULE',
    kind: 'personal_continuity',
    item_count: items.length,
    chars_used: budget.used,
    truncated: budget.truncated,
    items: Object.freeze(items.map((i) => Object.freeze(i)))
  });
}

function retrieveEngineeringCapsule(signals, config = loadSelfImprovementConfig()) {
  const tokens = signalTokensFrom(signals);
  const perSection = config.memory_capsule_max_items_per_section;

  // Engineering memory derives from durable RSI state: candidate history,
  // denial requirements, configured engineering notes, and repo architecture.
  let candidates = [];
  try {
    candidates = (store.listCandidates(config) || []).slice(0, perSection);
  } catch {
    candidates = [];
  }
  const approved = candidates.filter((c) => c.status === 'approved' || c.status === 'live');
  const denied = candidates.filter((c) => c.status === 'denied');

  const fileItems = collectFromSources(
    splitPipeList(config.memory_capsule_engineering_sources),
    config.project_root,
    tokens,
    config
  );
  const budget = enforceTotalBudget(fileItems, config.memory_capsule_total_max_chars);

  let architecture = null;
  const map = repoIntel.loadPersistedMap(config);
  if (map) {
    architecture = {
      files: map.counts.files,
      definitions: map.counts.definitions,
      tests: map.counts.tests,
      runtime_entry_points: map.runtime_entry_points
    };
  }

  return Object.freeze({
    marker: 'FLOKI_V2_RSI_ENGINEERING_CAPSULE',
    kind: 'engineering_memory',
    approved_candidates: Object.freeze(approved.map((c) => Object.freeze({ id: c.id, objective: (c.objective || '').slice(0, 200) }))),
    denial_requirements: Object.freeze(denied.map((c) => Object.freeze({ id: c.id, reason: c.denial_reason || c.deny_reason || null }))),
    repository_architecture: architecture,
    notes: Object.freeze(fileItems.map((i) => Object.freeze(i))),
    chars_used: budget.used,
    truncated: budget.truncated
  });
}

// Strictly separate capsules; the two memory kinds are never merged.
function retrieveCapsules(signals, config = loadSelfImprovementConfig()) {
  return Object.freeze({
    marker: 'FLOKI_V2_RSI_MEMORY_CAPSULES',
    personal: retrievePersonalCapsule(signals, config),
    engineering: retrieveEngineeringCapsule(signals, config)
  });
}

module.exports = {
  retrievePersonalCapsule,
  retrieveEngineeringCapsule,
  retrieveCapsules,
  signalTokensFrom,
  splitPipeList
};
