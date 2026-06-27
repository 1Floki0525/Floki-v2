'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { safeWriteMemory } = require(
  path.join(__dirname, '../../brain/hippocampus/index.cjs')
);

function truncate(s, max) {
  return String(s || '').slice(0, max);
}

function writeCycleMemory({ run_id, objective, outcome, reason, importance = 0.65 }) {
  const objShort = truncate(objective, 180);
  const summary = `RSI cycle (${run_id}): ${outcome}. Objective: "${objShort}"`;
  const detail = reason ? `Outcome: ${outcome}\nObjective: ${objective}\nReason: ${reason}` : '';
  return safeWriteMemory({
    stream: 'episodic',
    type: 'experience',
    source: 'system',
    content: { summary, detail: truncate(detail, 4000) },
    tags: ['rsi', 'self-improvement', 'cycle', outcome],
    importance
  });
}

function writeDenialMemory({ candidate_id, objective, denial_reason }) {
  const objShort = truncate(objective, 180);
  const summary = `Maker denied my RSI candidate (${candidate_id}): "${objShort}"`;
  const detail =
    `Objective: ${objective}\n\n` +
    `Maker denial reason:\n${denial_reason}\n\n` +
    `I must not repeat this mistake or re-select this objective without fully addressing every correction above.`;
  return safeWriteMemory({
    stream: 'episodic',
    type: 'experience',
    source: 'system',
    content: { summary, detail: truncate(detail, 5000) },
    tags: ['rsi', 'self-improvement', 'denial', 'correction', 'maker-feedback'],
    importance: 0.90
  });
}

function writeApprovalMemory({ candidate_id, objective }) {
  const objShort = truncate(objective, 180);
  const summary = `Maker approved my RSI candidate (${candidate_id}): "${objShort}"`;
  const detail = `Objective: ${objective}\n\nThis improvement was accepted by the Maker and promoted into my codebase.`;
  return safeWriteMemory({
    stream: 'autobiographical',
    type: 'experience',
    source: 'system',
    content: { summary, detail: truncate(detail, 3000) },
    tags: ['rsi', 'self-improvement', 'approved', 'promotion', 'achievement'],
    importance: 0.95
  });
}

// Flush memory writes queued by the agent inside the container.
// The agent writes to <outbox_root>/<run_id>-memory-writes.jsonl (flat file, outside
// runRoot so it survives exitNoCandidate cleanup). Called after the container exits.
function flushAgentMemoryOutbox(outboxRoot, runId) {
  const memFile = path.join(outboxRoot, runId + '-memory-writes.jsonl');
  if (!fs.existsSync(memFile)) return 0;
  let flushed = 0;
  try {
    const lines = fs.readFileSync(memFile, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const input = JSON.parse(line);
        if (!input || typeof input !== 'object') continue;
        safeWriteMemory({
          stream: input.stream || 'episodic',
          type: input.type || 'experience',
          source: 'system',
          content: {
            summary: truncate(input.summary, 2000),
            detail: truncate(input.detail || '', 5000)
          },
          tags: Array.isArray(input.tags) ? input.tags : ['rsi', 'agent-memory'],
          importance: typeof input.importance === 'number' ? input.importance : 0.7
        });
        flushed++;
      } catch (_) {}
    }
  } finally {
    try { fs.unlinkSync(memFile); } catch (_) {}
  }
  return flushed;
}

module.exports = {
  writeCycleMemory,
  writeDenialMemory,
  writeApprovalMemory,
  flushAgentMemoryOutbox
};
