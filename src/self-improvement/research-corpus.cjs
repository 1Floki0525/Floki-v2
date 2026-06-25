'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadResearchCorpus(workspaceRoot, relativePath) {
  const root = path.resolve(workspaceRoot);
  const file = path.resolve(root, String(relativePath || ''));
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error('research corpus path escapes workspace');
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payload.sources) || payload.sources.length === 0) {
    throw new Error('research corpus requires a non-empty sources array');
  }
  const ids = new Set();
  for (const source of payload.sources) {
    if (!source || typeof source.id !== 'string' || source.id.trim() === '') {
      throw new Error('research corpus source id is required');
    }
    if (ids.has(source.id)) {
      throw new Error('duplicate research corpus source id: ' + source.id);
    }
    ids.add(source.id);
    if (typeof source.url !== 'string' || source.url.trim() === '') {
      throw new Error('research corpus source URL is required: ' + source.id);
    }
  }
  return Object.freeze({
    ...payload,
    sources: Object.freeze(payload.sources.map((source) => Object.freeze({
      ...source,
      tags: Object.freeze(
        Array.isArray(source.tags) ? source.tags.map(String) : []
      )
    })))
  });
}

function searchableText(source) {
  return [
    source.id,
    source.title,
    source.kind,
    source.summary,
    ...(source.tags || [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function searchResearchCorpus(corpus, query, limit) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_+.-]+/)
    .filter(Boolean);
  const cap = Number(limit);
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error('research corpus search limit must be a positive integer');
  }
  return corpus.sources
    .map((source) => {
      const haystack = searchableText(source);
      const score = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0
      );
      return { source, score };
    })
    .filter((row) => terms.length === 0 || row.score > 0)
    .sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id))
    .slice(0, cap)
    .map((row) => row.source);
}

function getResearchCorpusSource(corpus, id) {
  const source = corpus.sources.find((entry) => entry.id === String(id));
  if (!source) throw new Error('unknown research corpus source: ' + id);
  return source;
}

module.exports = {
  getResearchCorpusSource,
  loadResearchCorpus,
  searchResearchCorpus
};
