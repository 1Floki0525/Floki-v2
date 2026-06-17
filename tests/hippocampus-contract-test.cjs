'use strict';

/**
 * Floki-v2 Hippocampus contract test.
 *
 * Proves:
 * - real module contract exists
 * - memory writes persist to JSONL
 * - memory recall works by tags/text
 * - provenance survives from source event to memory record
 * - unsafe private-reasoning markers are rejected
 * - hippocampus does not produce speech
 */

const assert = require('node:assert/strict');

const { validateModuleContract } = require('../src/brain/module-contract.cjs');
const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');
const { validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { statePath } = require('../src/util/fs-safe.cjs');
const { newId } = require('../src/util/ids.cjs');
const { readJsonlSync } = require('../src/util/jsonl.cjs');
const hippocampusModule = require('../brain/hippocampus/index.cjs');

function makeTestPaths(uniqueTag) {
  return {
    short_term: statePath(`test/hippocampus/${uniqueTag}/short-term.jsonl`),
    episodic: statePath(`test/hippocampus/${uniqueTag}/episodic.jsonl`),
    semantic: statePath(`test/hippocampus/${uniqueTag}/semantic.jsonl`),
    autobiographical: statePath(`test/hippocampus/${uniqueTag}/autobiographical.jsonl`)
  };
}

function run() {
  const uniqueTag = newId('hippotest').replace(/[^a-z0-9_]/g, '_');
  const memoryPaths = makeTestPaths(uniqueTag);

  const hippocampus = hippocampusModule.createHippocampus({
    persist_diagnostics: true,
    memory_paths: memoryPaths,
    diagnostics_path: statePath(`test/hippocampus/${uniqueTag}/diagnostics.jsonl`)
  });

  validateModuleContract(hippocampus.contract);
  assert.equal(hippocampus.contract.module, 'hippocampus');
  assert.equal(hippocampus.contract.production, true);

  const event = makeUserTextEvent('Floki should remember that his brain is being built before Minecraft.', {
    trace_id: uniqueTag
  });

  const writeOutput = hippocampus.rememberEvent(event, {
    stream: 'episodic',
    type: 'experience',
    tags: ['brain_first', 'terminal_chat', uniqueTag],
    importance: 0.88,
    affect: {
      valence: 0.35,
      arousal: 0.4
    }
  });

  validateBrainOutput(writeOutput);

  assert.equal(writeOutput.type, 'memory_write');
  assert.equal(writeOutput.source, 'hippocampus');
  assert.equal(writeOutput.payload.memory_stream, 'episodic');
  assert.equal(writeOutput.payload.memory_type, 'experience');
  assert.equal(writeOutput.payload.record.provenance.source_event_ids[0], event.id);
  assert.equal(writeOutput.payload.record.provenance.trace_id, uniqueTag);
  assert.equal(writeOutput.payload.record.provenance.safe_summary_only, true);
  assert.ok(writeOutput.payload.record.tags.includes('brain_first'));
  assert.ok(writeOutput.payload.record.tags.includes(uniqueTag));

  const persisted = readJsonlSync(memoryPaths.episodic);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, writeOutput.payload.memory_id);

  const recallOutput = hippocampus.recall({
    text: 'brain before Minecraft terminal',
    tags: [uniqueTag],
    streams: ['episodic'],
    limit: 5
  });

  validateBrainOutput(recallOutput);

  assert.equal(recallOutput.type, 'memory_recall');
  assert.equal(recallOutput.source, 'hippocampus');
  assert.ok(recallOutput.payload.match_count >= 1);

  const recalledIds = recallOutput.payload.matches.map((match) => match.record.id);
  assert.ok(recalledIds.includes(writeOutput.payload.memory_id));

  const unsafeWrite = hippocampus.safeWriteMemory({
    stream: 'semantic',
    type: 'fact',
    content: {
      summary: '<think>do not store this</think>',
      detail: ''
    },
    tags: ['unsafe_test']
  });

  validateBrainOutput(unsafeWrite);
  assert.equal(unsafeWrite.type, 'failure');
  assert.equal(unsafeWrite.source, 'hippocampus');
  assert.equal(unsafeWrite.failure.code, 'HIPPOCAMPUS_UNSAFE_MEMORY_RECORD');

  const shortTermWrite = hippocampus.writeMemory({
    stream: 'short_term',
    type: 'identity',
    content: {
      summary: 'Floki is being built brain-first before live embodiment.',
      detail: 'This identity-linked memory is safe summarized content.'
    },
    tags: ['identity', uniqueTag],
    importance: 0.95,
    confidence: 1,
    source_event_ids: [event.id],
    trace_id: uniqueTag,
    affect: {
      valence: 0.5,
      arousal: 0.3
    }
  });

  validateBrainOutput(shortTermWrite);
  assert.equal(shortTermWrite.type, 'memory_write');

  const consolidationOutput = hippocampus.consolidateShortTerm({
    min_importance: 0.9
  });

  validateBrainOutput(consolidationOutput);
  assert.equal(consolidationOutput.type, 'memory_write');
  assert.equal(consolidationOutput.payload.consolidation, true);
  assert.ok(consolidationOutput.payload.writes_count >= 1);

  const autobiographical = readJsonlSync(memoryPaths.autobiographical);
  assert.ok(autobiographical.length >= 1);
  assert.ok(autobiographical[0].tags.includes('consolidated'));

  assert.notEqual(writeOutput.type, 'speech');
  assert.notEqual(recallOutput.type, 'speech');
  assert.notEqual(consolidationOutput.type, 'speech');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HIPPOCAMPUS_CONTRACT_PASS',
    module: hippocampus.contract.module,
    event_id: event.id,
    memory_id: writeOutput.payload.memory_id,
    recall_match_count: recallOutput.payload.match_count,
    unsafe_marker_rejected: unsafeWrite.failure.code,
    consolidation_writes: consolidationOutput.payload.writes_count,
    speech_created_by_hippocampus: false
  }, null, 2));
}

run();
