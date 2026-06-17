'use strict';

/**
 * Floki-v2 Hippocampus
 *
 * Responsibility:
 * - Write persistent memories.
 * - Recall memories deterministically.
 * - Preserve provenance from brain events.
 * - Consolidate important short-term memories into longer-lived streams.
 *
 * The hippocampus does not:
 * - speak
 * - call models
 * - decide goals
 * - move a body
 * - touch Minecraft
 */

const { createModuleContract, validateModuleContract, makeModuleDiagnostic } = require('../../src/brain/module-contract.cjs');
const { validateBrainEvent } = require('../../src/brain/brain-event-schema.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync, readJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');
const {
  MEMORY_STREAMS,
  normalizeStream,
  normalizeTags,
  createMemoryRecord,
  validateMemoryRecord,
  scoreMemoryRecord,
  rejectUnsafeMarkers
} = require('../../src/brain/memory-record-schema.cjs');

const MODULE_NAME = 'hippocampus';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Writes, recalls, and consolidates persistent memories while preserving provenance and storing only safe summaries.',
  inputs: [
    {
      name: 'brain_event',
      schema: 'src/brain/brain-event-schema.cjs',
      required: false,
      description: 'Validated event that can become a provenance-linked memory.'
    },
    {
      name: 'memory_record_input',
      schema: 'src/brain/memory-record-schema.cjs',
      required: false,
      description: 'Safe summarized memory content, tags, affect, importance, and provenance.'
    },
    {
      name: 'recall_query',
      schema: 'plain object',
      required: false,
      description: 'Text, tags, stream, type, or source event ids used for deterministic recall.'
    }
  ],
  outputs: [
    {
      type: 'memory_write',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A validated memory write output with record id and path.'
    },
    {
      type: 'memory_recall',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A validated memory recall output containing scored safe memory records.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'Structured failure output when memory write or recall cannot safely continue.'
    }
  ],
  state_reads: [
    {
      path: 'state/floki/memories/short-term.jsonl',
      description: 'Short-term safe summarized memories.'
    },
    {
      path: 'state/floki/memories/episodic.jsonl',
      description: 'Event-like remembered experiences.'
    },
    {
      path: 'state/floki/memories/semantic.jsonl',
      description: 'Stable facts and generalized knowledge.'
    },
    {
      path: 'state/floki/memories/autobiographical.jsonl',
      description: 'Identity-linked life-story memories.'
    }
  ],
  state_writes: [
    {
      path: 'state/floki/memories/short-term.jsonl',
      description: 'Append-only short-term memory writes.'
    },
    {
      path: 'state/floki/memories/episodic.jsonl',
      description: 'Append-only episodic memory writes.'
    },
    {
      path: 'state/floki/memories/semantic.jsonl',
      description: 'Append-only semantic memory writes.'
    },
    {
      path: 'state/floki/memories/autobiographical.jsonl',
      description: 'Append-only autobiographical memory writes.'
    },
    {
      path: 'state/floki/diagnostics.jsonl',
      description: 'Append-only hippocampus diagnostics.'
    }
  ],
  diagnostics: [
    {
      name: 'memory_written',
      description: 'A safe memory record was appended to its stream.'
    },
    {
      name: 'memory_recalled',
      description: 'A deterministic recall query returned scored matches.'
    },
    {
      name: 'memory_consolidated',
      description: 'Important short-term memories were copied into longer-lived streams.'
    },
    {
      name: 'memory_failed',
      description: 'A memory operation failed safely.'
    }
  ],
  failure_modes: [
    {
      code: 'HIPPOCAMPUS_INVALID_EVENT',
      description: 'Input event failed validation.'
    },
    {
      code: 'HIPPOCAMPUS_UNSAFE_MEMORY_RECORD',
      description: 'Memory content was invalid or contained unsafe private-reasoning markers.'
    },
    {
      code: 'HIPPOCAMPUS_WRITE_FAILED',
      description: 'The memory record could not be appended.'
    },
    {
      code: 'HIPPOCAMPUS_RECALL_FAILED',
      description: 'Memory recall failed because query or stored records were invalid.'
    },
    {
      code: 'HIPPOCAMPUS_CONSOLIDATION_FAILED',
      description: 'Short-term consolidation failed.'
    }
  ],
  forbidden: [
    'speech_generation',
    'model_calls',
    'minecraft_calls',
    'body_movement',
    'private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Hippocampus writes safe summaries and provenance-linked memories. It does not generate speech or call cognition models.'
});

function defaultMemoryPaths() {
  return {
    short_term: statePath('memories/short-term.jsonl'),
    episodic: statePath('memories/episodic.jsonl'),
    semantic: statePath('memories/semantic.jsonl'),
    autobiographical: statePath('memories/autobiographical.jsonl')
  };
}

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function resolveMemoryPaths(options = {}) {
  return {
    ...defaultMemoryPaths(),
    ...(options.memory_paths || {})
  };
}

function memoryPathForStream(stream, options = {}) {
  const normalized = normalizeStream(stream);
  const paths = resolveMemoryPaths(options);

  if (!paths[normalized]) {
    throw new Error(`no memory path configured for stream: ${normalized}`);
  }

  return paths[normalized];
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return {
      ok: true,
      skipped: true,
      path: null
    };
  }

  const diagnosticPath = options.diagnostics_path || statePath('diagnostics.jsonl');

  appendJsonlSync(diagnosticPath, {
    id: diagnosticId(),
    created_at: nowIso(),
    module: MODULE_NAME,
    ...record
  });

  return {
    ok: true,
    skipped: false,
    path: diagnosticPath
  };
}

function deriveMemoryContentFromEvent(event) {
  validateBrainEvent(event);

  if (event.payload && typeof event.payload.text === 'string' && event.payload.text.trim()) {
    return {
      summary: event.payload.text.trim(),
      detail: ''
    };
  }

  return {
    summary: `Observed ${event.type} event from ${event.source}.`,
    detail: JSON.stringify({
      type: event.type,
      source: event.source,
      modality: event.modality,
      payload: event.payload
    })
  };
}

function writeMemory(input, options = {}) {
  const record = createMemoryRecord({
    ...input,
    source: input.source || MODULE_NAME
  });

  const filePath = memoryPathForStream(record.stream, options);

  try {
    appendJsonlSync(filePath, record);
  } catch (error) {
    const failure = makeFailureOutput(
      MODULE_NAME,
      'HIPPOCAMPUS_WRITE_FAILED',
      error.message,
      {
        parent_event_ids: record.provenance.source_event_ids,
        payload: {
          memory_stream: record.stream,
          memory_type: record.type
        }
      }
    );

    persistDiagnostic({
      status: 'memory_failed',
      failure_code: failure.failure.code,
      message: error.message
    }, options);

    return failure;
  }

  const output = createBrainOutput({
    type: 'memory_write',
    source: MODULE_NAME,
    parent_event_ids: record.provenance.source_event_ids,
    payload: {
      memory_id: record.id,
      memory_stream: record.stream,
      memory_type: record.type,
      path: filePath,
      record
    },
    diagnostics: {
      module: MODULE_NAME,
      status: 'memory_written',
      safe_summary_only: true
    }
  });

  persistDiagnostic({
    status: 'memory_written',
    memory_id: record.id,
    memory_stream: record.stream,
    memory_type: record.type,
    source_event_ids: record.provenance.source_event_ids
  }, options);

  return output;
}

function safeWriteMemory(input, options = {}) {
  try {
    return writeMemory(input, options);
  } catch (error) {
    const failure = makeFailureOutput(
      MODULE_NAME,
      classifyMemoryError(error, 'write'),
      error.message,
      {
        parent_event_ids: Array.isArray(input && input.source_event_ids) ? input.source_event_ids : [],
        payload: {
          attempted_stream: input && input.stream ? input.stream : null,
          attempted_type: input && input.type ? input.type : null
        }
      }
    );

    try {
      persistDiagnostic({
        status: 'memory_failed',
        failure_code: failure.failure.code,
        message: error.message
      }, options);
    } catch (_) {
      return failure;
    }

    return failure;
  }
}

function rememberEvent(event, options = {}) {
  validateBrainEvent(event);

  const content = options.content || deriveMemoryContentFromEvent(event);
  rejectUnsafeMarkers(content, 'event-derived memory content');

  return writeMemory({
    stream: options.stream || 'short_term',
    type: options.type || 'experience',
    source: MODULE_NAME,
    content,
    tags: options.tags || eventTags(event),
    importance: typeof options.importance === 'number' ? options.importance : defaultImportanceForEvent(event),
    confidence: typeof options.confidence === 'number' ? options.confidence : event.provenance.confidence,
    affect: options.affect || {
      valence: 0,
      arousal: 0.2
    },
    source_event_ids: [event.id],
    trace_id: event.provenance.trace_id,
    observed_by: event.provenance.observed_by
  }, options);
}

function safeRememberEvent(event, options = {}) {
  try {
    return rememberEvent(event, options);
  } catch (error) {
    return makeFailureOutput(
      MODULE_NAME,
      classifyMemoryError(error, 'remember_event'),
      error.message,
      {
        parent_event_ids: event && event.id ? [event.id] : [],
        payload: {
          event_type: event && event.type ? event.type : null
        }
      }
    );
  }
}

function recall(query = {}, options = {}) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('recall query must be a plain object');
  }

  rejectUnsafeMarkers(query, 'recall query');

  const limit = normalizeLimit(options.limit || query.limit || 10);
  const streams = normalizeRecallStreams(query.streams || query.stream || MEMORY_STREAMS);
  const paths = resolveMemoryPaths(options);
  const scored = [];

  for (const stream of streams) {
    const filePath = paths[stream];

    if (!filePath) {
      continue;
    }

    const records = readJsonlSync(filePath, {
      limit: options.read_limit || 10000
    });

    for (const record of records) {
      validateMemoryRecord(record);

      const score = scoreMemoryRecord(record, {
        ...query,
        stream: query.stream || undefined
      });

      if (score > 0 || query.include_zero_score === true) {
        scored.push({
          score,
          stream,
          path: filePath,
          record
        });
      }
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return b.record.created_at.localeCompare(a.record.created_at);
  });

  const matches = scored.slice(0, limit);

  const output = createBrainOutput({
    type: 'memory_recall',
    source: MODULE_NAME,
    parent_event_ids: Array.isArray(query.source_event_ids) ? query.source_event_ids : [],
    payload: {
      query: sanitizeRecallQueryForOutput(query),
      matches,
      match_count: matches.length,
      searched_streams: streams
    },
    diagnostics: {
      module: MODULE_NAME,
      status: 'memory_recalled',
      total_candidates: scored.length,
      returned: matches.length
    }
  });

  persistDiagnostic({
    status: 'memory_recalled',
    match_count: matches.length,
    searched_streams: streams,
    query: sanitizeRecallQueryForOutput(query)
  }, options);

  return output;
}

function safeRecall(query = {}, options = {}) {
  try {
    return recall(query, options);
  } catch (error) {
    return makeFailureOutput(
      MODULE_NAME,
      'HIPPOCAMPUS_RECALL_FAILED',
      error.message,
      {
        parent_event_ids: Array.isArray(query && query.source_event_ids) ? query.source_event_ids : [],
        payload: {
          query: sanitizeRecallQueryForOutput(query || {})
        }
      }
    );
  }
}

function consolidateShortTerm(options = {}) {
  try {
    const paths = resolveMemoryPaths(options);
    const shortTermRecords = readJsonlSync(paths.short_term, {
      limit: options.read_limit || 10000
    });

    const minImportance = typeof options.min_importance === 'number' ? options.min_importance : 0.7;
    const writes = [];

    for (const record of shortTermRecords) {
      validateMemoryRecord(record);

      if (record.importance < minImportance) {
        continue;
      }

      const targetStream = record.type === 'identity' ? 'autobiographical' : 'episodic';

      const writeOutput = writeMemory({
        stream: targetStream,
        type: record.type,
        source: MODULE_NAME,
        content: {
          summary: record.content.summary,
          detail: record.content.detail
        },
        tags: [...record.tags, 'consolidated'],
        importance: record.importance,
        confidence: record.confidence,
        affect: record.affect,
        source_event_ids: record.provenance.source_event_ids,
        source_memory_ids: [record.id],
        trace_id: record.provenance.trace_id,
        observed_by: MODULE_NAME
      }, options);

      writes.push(writeOutput);
    }

    const failures = writes.filter((output) => output.type === 'failure');

    const output = createBrainOutput({
      type: 'memory_write',
      source: MODULE_NAME,
      parent_event_ids: [],
      parent_output_ids: writes.map((item) => item.id),
      payload: {
        consolidation: true,
        source_stream: 'short_term',
        writes_count: writes.length,
        failures_count: failures.length,
        write_outputs: writes
      },
      diagnostics: {
        module: MODULE_NAME,
        status: 'memory_consolidated',
        min_importance: minImportance
      }
    });

    persistDiagnostic({
      status: 'memory_consolidated',
      source_stream: 'short_term',
      writes_count: writes.length,
      failures_count: failures.length
    }, options);

    return output;
  } catch (error) {
    return makeFailureOutput(
      MODULE_NAME,
      'HIPPOCAMPUS_CONSOLIDATION_FAILED',
      error.message,
      {
        payload: {
          source_stream: 'short_term'
        }
      }
    );
  }
}

function eventTags(event) {
  validateBrainEvent(event);

  return normalizeTags([
    event.type,
    event.source,
    event.modality
  ]);
}

function defaultImportanceForEvent(event) {
  if (event.type === 'user_text') {
    return 0.6;
  }

  if (event.type === 'personality_update' || event.type === 'memory_consolidation') {
    return 0.85;
  }

  if (event.type === 'safety_interruption') {
    return 0.95;
  }

  return 0.5;
}

function normalizeLimit(limit) {
  const numeric = Number(limit);

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100) {
    throw new TypeError('recall limit must be an integer from 1 to 100');
  }

  return numeric;
}

function normalizeRecallStreams(streams) {
  if (typeof streams === 'string') {
    return [normalizeStream(streams)];
  }

  if (!Array.isArray(streams)) {
    throw new TypeError('recall streams must be a string or array');
  }

  const normalized = [];

  for (const stream of streams) {
    const safeStream = normalizeStream(stream);
    if (!normalized.includes(safeStream)) {
      normalized.push(safeStream);
    }
  }

  return normalized;
}

function sanitizeRecallQueryForOutput(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    return {};
  }

  return {
    text: typeof query.text === 'string' ? query.text.slice(0, 500) : '',
    tags: normalizeTags(query.tags || []),
    stream: typeof query.stream === 'string' ? normalizeStream(query.stream) : null,
    streams: Array.isArray(query.streams) ? normalizeRecallStreams(query.streams) : null,
    type: typeof query.type === 'string' ? query.type : null,
    source_event_ids: Array.isArray(query.source_event_ids) ? query.source_event_ids.slice() : []
  };
}

function classifyMemoryError(error, operation) {
  const message = error && error.message ? error.message : '';

  if (message.includes('private-reasoning marker')) {
    return 'HIPPOCAMPUS_UNSAFE_MEMORY_RECORD';
  }

  if (operation === 'remember_event') {
    return 'HIPPOCAMPUS_INVALID_EVENT';
  }

  return 'HIPPOCAMPUS_UNSAFE_MEMORY_RECORD';
}

function createHippocampus(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    writeMemory: (input, memoryOptions = {}) => writeMemory(input, { ...options, ...memoryOptions }),
    safeWriteMemory: (input, memoryOptions = {}) => safeWriteMemory(input, { ...options, ...memoryOptions }),
    rememberEvent: (event, memoryOptions = {}) => rememberEvent(event, { ...options, ...memoryOptions }),
    safeRememberEvent: (event, memoryOptions = {}) => safeRememberEvent(event, { ...options, ...memoryOptions }),
    recall: (query, recallOptions = {}) => recall(query, { ...options, ...recallOptions }),
    safeRecall: (query, recallOptions = {}) => safeRecall(query, { ...options, ...recallOptions }),
    consolidateShortTerm: (memoryOptions = {}) => consolidateShortTerm({ ...options, ...memoryOptions }),
    diagnostics: () => makeModuleDiagnostic(MODULE_NAME, 'ready', {
      streams: MEMORY_STREAMS,
      paths: resolveMemoryPaths(options)
    })
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  getContract,
  defaultMemoryPaths,
  resolveMemoryPaths,
  memoryPathForStream,
  deriveMemoryContentFromEvent,
  writeMemory,
  safeWriteMemory,
  rememberEvent,
  safeRememberEvent,
  recall,
  safeRecall,
  consolidateShortTerm,
  createHippocampus
};
