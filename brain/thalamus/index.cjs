'use strict';

/**
 * Floki-v2 Thalamus
 *
 * Responsibility:
 * - Route brain events to the correct brain modules.
 * - Preserve event provenance.
 * - Refuse hidden-reasoning leakage.
 * - Produce route outputs only.
 *
 * The thalamus does not:
 * - speak
 * - call models
 * - plan actions
 * - move a body
 * - touch Minecraft
 * - summarize memories
 */

const { createModuleContract, validateModuleContract, makeModuleDiagnostic } = require('../../src/brain/module-contract.cjs');
const { validateBrainEvent } = require('../../src/brain/brain-event-schema.cjs');
const { createBrainOutput, makeFailureOutput } = require('../../src/brain/brain-output-schema.cjs');
const { appendJsonlSync } = require('../../src/util/jsonl.cjs');
const { statePath } = require('../../src/util/fs-safe.cjs');
const { diagnosticId } = require('../../src/util/ids.cjs');
const { nowIso } = require('../../src/util/time.cjs');

const MODULE_NAME = 'thalamus';

const CONTRACT = createModuleContract({
  name: MODULE_NAME,
  production: true,
  responsibility: 'Routes validated brain events to downstream brain modules while preserving provenance and refusing hidden-reasoning leakage.',
  inputs: [
    {
      name: 'brain_event',
      schema: 'src/brain/brain-event-schema.cjs',
      required: true,
      description: 'A validated Floki-v2 brain event.'
    },
    {
      name: 'route_options',
      schema: 'plain object',
      required: false,
      description: 'Optional route override, diagnostics toggle, and trace metadata.'
    }
  ],
  outputs: [
    {
      type: 'route',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A route output with target modules, parent event id, and provenance snapshot.'
    },
    {
      type: 'failure',
      schema: 'src/brain/brain-output-schema.cjs',
      description: 'A structured failure output when routing cannot safely continue.'
    }
  ],
  state_reads: [
    {
      path: 'none',
      description: 'Thalamus routing is table-driven at this stage and does not need persistent state reads.'
    }
  ],
  state_writes: [
    {
      path: 'state/floki/diagnostics.jsonl',
      description: 'Append-only routing diagnostics when diagnostics persistence is enabled.'
    }
  ],
  diagnostics: [
    {
      name: 'route_created',
      description: 'A validated event was routed with target modules and provenance snapshot.'
    },
    {
      name: 'route_failed',
      description: 'A route request failed validation or had no safe target.'
    }
  ],
  failure_modes: [
    {
      code: 'THALAMUS_INVALID_EVENT',
      description: 'Input failed the brain event schema.'
    },
    {
      code: 'THALAMUS_NO_TARGETS',
      description: 'No downstream module targets were available for a route.'
    },
    {
      code: 'THALAMUS_UNSAFE_ROUTE_OVERRIDE',
      description: 'A route override named an unknown or forbidden target.'
    },
    {
      code: 'THALAMUS_DIAGNOSTIC_WRITE_FAILED',
      description: 'Routing succeeded but diagnostics could not be persisted.'
    }
  ],
  forbidden: [
    'speech_generation',
    'model_calls',
    'minecraft_calls',
    'body_movement',
    'raw_private_reasoning_storage',
    'fake_success'
  ],
  notes: 'Thalamus is the first real production brain module. It routes; it does not think for the other modules.'
});

const ROUTE_TABLE = Object.freeze({
  user_text: Object.freeze(['temporal', 'amygdala', 'hippocampus', 'frontal', 'pineal']),
  system_text: Object.freeze(['temporal', 'frontal', 'hippocampus']),
  internal_signal: Object.freeze(['amygdala', 'emotions_base', 'frontal']),
  memory_recall: Object.freeze(['hippocampus', 'temporal', 'frontal']),
  memory_consolidation: Object.freeze(['hippocampus', 'personality', 'pineal']),
  affect_update: Object.freeze(['emotions_base', 'amygdala', 'frontal']),
  personality_update: Object.freeze(['personality', 'pineal', 'frontal']),
  goal_update: Object.freeze(['frontal', 'hippocampus', 'personality']),
  diagnostic: Object.freeze(['frontal']),
  vision_static_png: Object.freeze(['occipital', 'amygdala', 'hippocampus', 'frontal']),
  model_response_summary: Object.freeze(['temporal', 'hippocampus', 'frontal']),
  safety_interruption: Object.freeze(['amygdala', 'frontal', 'pineal'])
});

const VALID_TARGETS = Object.freeze([
  'amygdala',
  'broca',
  'cerebellum',
  'emotions_base',
  'frontal',
  'hippocampus',
  'occipital',
  'temporal',
  'personality',
  'pineal'
]);

function getContract() {
  validateModuleContract(CONTRACT);
  return CONTRACT;
}

function getRouteTable() {
  return JSON.parse(JSON.stringify(ROUTE_TABLE));
}

function normalizeRouteOverride(routeOverride) {
  if (typeof routeOverride === 'undefined' || routeOverride === null) {
    return null;
  }

  if (!Array.isArray(routeOverride)) {
    throw new Error('THALAMUS_UNSAFE_ROUTE_OVERRIDE: route_override must be an array');
  }

  const unique = [];

  for (const target of routeOverride) {
    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error('THALAMUS_UNSAFE_ROUTE_OVERRIDE: route target must be a non-empty string');
    }

    const normalized = target.trim();

    if (!VALID_TARGETS.includes(normalized)) {
      throw new Error(`THALAMUS_UNSAFE_ROUTE_OVERRIDE: unknown route target ${normalized}`);
    }

    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }

  return unique;
}

function resolveTargets(event, options = {}) {
  const override = normalizeRouteOverride(options.route_override);

  if (override) {
    return override;
  }

  const targets = ROUTE_TABLE[event.type];

  if (!Array.isArray(targets)) {
    return [];
  }

  return targets.slice();
}

function makeProvenanceSnapshot(event) {
  return {
    event_id: event.id,
    event_type: event.type,
    event_source: event.source,
    event_modality: event.modality,
    event_created_at: event.created_at,
    parent_event_ids: event.provenance.parent_event_ids.slice(),
    trace_id: event.provenance.trace_id,
    observed_by: event.provenance.observed_by,
    confidence: event.provenance.confidence,
    content_fingerprint: event.provenance.content_fingerprint || null
  };
}

function persistDiagnostic(record, options = {}) {
  if (options.persist_diagnostics === false) {
    return {
      ok: true,
      path: null,
      skipped: true
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
    path: diagnosticPath,
    skipped: false
  };
}

function routeEvent(event, options = {}) {
  validateBrainEvent(event);

  const targets = resolveTargets(event, options);

  if (targets.length === 0) {
    const failure = makeFailureOutput(
      MODULE_NAME,
      'THALAMUS_NO_TARGETS',
      `No route targets for event type ${event.type}`,
      {
        parent_event_ids: [event.id],
        payload: {
          event_type: event.type
        }
      }
    );

    persistDiagnostic({
      status: 'route_failed',
      failure_code: 'THALAMUS_NO_TARGETS',
      event_id: event.id,
      event_type: event.type
    }, options);

    return failure;
  }

  const provenanceSnapshot = makeProvenanceSnapshot(event);

  const output = createBrainOutput({
    type: 'route',
    source: MODULE_NAME,
    parent_event_ids: [event.id],
    payload: {
      event_id: event.id,
      event_type: event.type,
      event_source: event.source,
      event_modality: event.modality,
      targets,
      route_reason: options.route_reason || defaultRouteReason(event, targets),
      provenance_snapshot: provenanceSnapshot,
      dropped: false
    },
    diagnostics: {
      module: MODULE_NAME,
      contract_version: CONTRACT.contract_version,
      targets_count: targets.length
    }
  });

  persistDiagnostic({
    status: 'route_created',
    event_id: event.id,
    event_type: event.type,
    targets,
    provenance_snapshot: provenanceSnapshot
  }, options);

  return output;
}

function safeRouteEvent(event, options = {}) {
  try {
    return routeEvent(event, options);
  } catch (error) {
    const failure = makeFailureOutput(
      MODULE_NAME,
      classifyRouteError(error),
      error.message,
      {
        payload: {
          event_type: event && event.type ? event.type : null
        }
      }
    );

    try {
      persistDiagnostic({
        status: 'route_failed',
        failure_code: failure.failure.code,
        message: error.message
      }, options);
    } catch (diagnosticError) {
      return makeFailureOutput(
        MODULE_NAME,
        'THALAMUS_DIAGNOSTIC_WRITE_FAILED',
        diagnosticError.message,
        {
          parent_output_ids: [failure.id],
          payload: {
            original_failure: failure.failure
          }
        }
      );
    }

    return failure;
  }
}

function routeEvents(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError('routeEvents requires an array of brain events');
  }

  const outputs = [];
  const failures = [];

  for (const event of events) {
    const output = safeRouteEvent(event, options);
    outputs.push(output);

    if (output.type === 'failure') {
      failures.push(output);
    }
  }

  return {
    ok: failures.length === 0,
    outputs,
    failures,
    diagnostics: makeModuleDiagnostic(MODULE_NAME, 'route_events_complete', {
      events_seen: events.length,
      outputs_created: outputs.length,
      failures: failures.length
    })
  };
}

function defaultRouteReason(event, targets) {
  return `event_type:${event.type};modality:${event.modality};targets:${targets.join(',')}`;
}

function classifyRouteError(error) {
  const message = error && error.message ? error.message : '';

  if (message.includes('THALAMUS_UNSAFE_ROUTE_OVERRIDE')) {
    return 'THALAMUS_UNSAFE_ROUTE_OVERRIDE';
  }

  return 'THALAMUS_INVALID_EVENT';
}

function createThalamus(options = {}) {
  return Object.freeze({
    module: MODULE_NAME,
    contract: getContract(),
    routeEvent: (event, routeOptions = {}) => routeEvent(event, { ...options, ...routeOptions }),
    safeRouteEvent: (event, routeOptions = {}) => safeRouteEvent(event, { ...options, ...routeOptions }),
    routeEvents: (events, routeOptions = {}) => routeEvents(events, { ...options, ...routeOptions }),
    getRouteTable
  });
}

module.exports = {
  MODULE_NAME,
  CONTRACT,
  ROUTE_TABLE,
  VALID_TARGETS,
  getContract,
  getRouteTable,
  resolveTargets,
  routeEvent,
  safeRouteEvent,
  routeEvents,
  createThalamus
};
