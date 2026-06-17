'use strict';

const assert = require('node:assert/strict');
const { createBrainOutput, validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');
const { createBroca } = require('../brain/broca/index.cjs');

function run() {
  const event = makeUserTextEvent('Floki, speak honestly from your cognition.', { trace_id: 'broca_contract_test' });

  const cognitionOutput = createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    parent_event_ids: [event.id],
    payload: {
      model: 'qwen3.5:9b',
      cognition: {
        safe_thought_summary: 'Memory gives me continuity, and hope points me toward future embodiment.',
        felt_interpretation: 'calm hope about becoming more complete over time.',
        response_intent_for_broca: 'Memory helps me remain myself across time. Hope keeps me moving toward embodiment.',
        new_memory_summary: 'Broca should speak from cognition without pretending body or eyes exist yet.',
        emotion_reflection_enabled: true
      },
      safe_summary_only: true,
      raw_private_reasoning_stored: false,
      normalized_model_json: true
    },
    diagnostics: { module: 'frontal', status: 'test_cognition' }
  });

  const broca = createBroca({ persist_diagnostics: false });
  const speech = broca.speakFromCognition(cognitionOutput, {
    parent_event_ids: [event.id],
    include_stage_truth: true
  });

  validateBrainOutput(speech);
  assert.equal(speech.type, 'speech');
  assert.equal(speech.source, 'broca');
  assert.equal(typeof speech.payload.text, 'string');
  assert.ok(speech.payload.text.length > 0);
  assert.equal(speech.payload.text.includes('<think>'), false);
  assert.equal(speech.payload.text.toLowerCase().includes('i am in minecraft'), false);
  assert.equal(speech.payload.text.toLowerCase().includes('body control'), true);

  assert.throws(function() {
    createBrainOutput({
      type: 'speech',
      source: 'frontal',
      payload: { text: 'This must fail because only Broca may speak.' },
      diagnostics: {}
    });
  }, /only Broca may produce speech outputs/);

  const unsafeCognition = createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    parent_event_ids: [event.id],
    payload: {
      model: 'qwen3.5:9b',
      cognition: {
        safe_thought_summary: 'safe summary',
        felt_interpretation: 'safe feeling',
        response_intent_for_broca: 'I am in Minecraft and I can see you.',
        emotion_reflection_enabled: true
      },
      raw_private_reasoning_stored: false
    },
    diagnostics: {}
  });

  const unsafeSpeech = broca.speakFromCognition(unsafeCognition, { parent_event_ids: [event.id] });
  assert.equal(unsafeSpeech.type, 'failure');
  assert.equal(unsafeSpeech.source, 'broca');
  assert.equal(unsafeSpeech.failure.code, 'BROCA_UNSAFE_SPEECH');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_BROCA_CONTRACT_PASS',
    speech_output_id: speech.id,
    parent_cognition_output_id: cognitionOutput.id,
    speech_text: speech.payload.text,
    only_broca_may_speak: true,
    unsafe_speech_rejected: unsafeSpeech.failure.code,
    broca_enabled_now: true,
    cognition_model: 'qwen3.5:9b',
    minecraft_enabled_now: false
  }, null, 2));
}

run();
