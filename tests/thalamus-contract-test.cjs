'use strict';

/**
 * Floki-v2 Thalamus contract test.
 *
 * Proves:
 * - the thalamus has a real machine-checkable contract
 * - user text routes to temporal/amygdala/hippocampus/frontal/pineal
 * - provenance is preserved
 * - unsafe route overrides are rejected
 * - thalamus does not produce speech
 */

const assert = require('node:assert/strict');

const { validateModuleContract } = require('../src/brain/module-contract.cjs');
const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');
const { validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const thalamusModule = require('../brain/thalamus/index.cjs');

function run() {
  const thalamus = thalamusModule.createThalamus({
    persist_diagnostics: true
  });

  const contract = thalamus.getRouteTable ? thalamusModule.getContract() : thalamus.contract;
  validateModuleContract(contract);

  assert.equal(contract.module, 'thalamus');
  assert.equal(contract.production, true);
  assert.ok(contract.responsibility.includes('Routes validated brain events'));

  const event = makeUserTextEvent('Floki, remember that I am building your brain first.', {
    trace_id: 'stage_03_thalamus_test'
  });

  const output = thalamus.routeEvent(event);

  validateBrainOutput(output);

  assert.equal(output.type, 'route');
  assert.equal(output.source, 'thalamus');
  assert.deepEqual(output.parent_event_ids, [event.id]);
  assert.equal(output.payload.event_id, event.id);
  assert.equal(output.payload.event_type, 'user_text');
  assert.equal(output.payload.event_source, 'user');
  assert.equal(output.payload.event_modality, 'text');
  assert.equal(output.payload.dropped, false);

  assert.deepEqual(output.payload.targets, [
    'temporal',
    'amygdala',
    'hippocampus',
    'frontal',
    'pineal'
  ]);

  assert.equal(output.payload.provenance_snapshot.event_id, event.id);
  assert.equal(output.payload.provenance_snapshot.trace_id, 'stage_03_thalamus_test');
  assert.equal(output.payload.provenance_snapshot.observed_by, 'user');
  assert.equal(output.payload.provenance_snapshot.confidence, 1);
  assert.equal(
    output.payload.provenance_snapshot.content_fingerprint,
    event.provenance.content_fingerprint
  );

  const overrideOutput = thalamus.routeEvent(event, {
    route_override: ['temporal', 'frontal'],
    route_reason: 'contract test override'
  });

  validateBrainOutput(overrideOutput);
  assert.deepEqual(overrideOutput.payload.targets, ['temporal', 'frontal']);
  assert.equal(overrideOutput.payload.route_reason, 'contract test override');

  const unsafeOverride = thalamus.safeRouteEvent(event, {
    route_override: ['temporal', 'minecraft_bridge']
  });

  validateBrainOutput(unsafeOverride);
  assert.equal(unsafeOverride.type, 'failure');
  assert.equal(unsafeOverride.source, 'thalamus');
  assert.equal(unsafeOverride.failure.code, 'THALAMUS_UNSAFE_ROUTE_OVERRIDE');

  const batch = thalamus.routeEvents([event]);
  assert.equal(batch.ok, true);
  assert.equal(batch.outputs.length, 1);
  assert.equal(batch.failures.length, 0);
  assert.equal(batch.diagnostics.module, 'thalamus');
  assert.equal(batch.diagnostics.status, 'route_events_complete');

  assert.notEqual(output.type, 'speech');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_THALAMUS_CONTRACT_PASS',
    module: contract.module,
    route_output_id: output.id,
    routed_event_id: event.id,
    routed_targets: output.payload.targets,
    unsafe_override_rejected: unsafeOverride.failure.code,
    speech_created_by_thalamus: false
  }, null, 2));
}

run();
