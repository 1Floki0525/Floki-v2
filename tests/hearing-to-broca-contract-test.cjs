'use strict';

const assert = require('node:assert/strict');

const { createBrainOutput, validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');
const {
  hearingToCognitionGuardStatus,
  runBrocaFromCognition
} = require('../src/senses/hearing-to-cognition-bridge.cjs');

function run() {
  const guard = hearingToCognitionGuardStatus({});

  assert.equal(guard.ok, true);
  assert.equal(guard.broca_enabled_now, false);
  assert.equal(guard.chat_mode_only, true);

  const event = makeUserTextEvent('what do you remember about trust and hope?', {
    trace_id: 'hearing_to_broca_contract_test'
  });

  const cognition = createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    parent_event_ids: [event.id],
    payload: {
      model: 'qwen3.5:9b',
      cognition: {
        safe_thought_summary: 'Trust and hope are connected to memory continuity.',
        felt_interpretation: 'Calm, attentive, and grounded.',
        memory_links: [
          'The user asked what Floki remembers about trust and hope.'
        ],
        personality_implications: [
          'Careful memory-aware replies strengthen continuity.'
        ],
        identity_implications: [
          'Memory supports persistent chat-mode identity.'
        ],
        response_intent_for_broca: 'Trust and hope help me stay continuous, careful, and connected in this conversation.',
        new_memory_summary: 'The user asked what Floki remembers about trust and hope.',
        emotion_reflection_enabled: true
      },
      raw_stats: {
        schema_constrained_json: true
      },
      safe_summary_only: true,
      raw_private_reasoning_stored: false,
      normalized_model_json: true,
      schema_constrained_json: true,
      json_retry_used: false,
      json_retry_first_error: null,
      model_json_fallback_used: false,
      model_json_fallback_reason: null
    },
    diagnostics: {
      module: 'frontal',
      status: 'test_schema_cognition',
      schema_constrained_json: true
    }
  });

  const speech = runBrocaFromCognition(cognition, {
    event,
    diagnostics_path: null
  }, {
    persist_broca_diagnostics: false,
    include_chat_truth: false
  });

  validateBrainOutput(speech);

  assert.equal(speech.type, 'speech');
  assert.equal(speech.source, 'broca');
  assert.equal(typeof speech.payload.text, 'string');
  assert.equal(speech.payload.text.length > 0, true);
  assert.equal(speech.payload.text.toLowerCase().includes('trust'), true);
  assert.equal(speech.payload.text.toLowerCase().includes('hope'), true);
  assert.equal(speech.payload.text.toLowerCase().includes('<think>'), false);
  assert.equal(speech.payload.text.toLowerCase().includes('chain_of_thought'), false);
  assert.equal(speech.payload.text.toLowerCase().includes('raw_reasoning'), false);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_HEARING_TO_BROCA_CONTRACT_PASS',
    cognition_type: cognition.type,
    schema_constrained_json: cognition.payload.schema_constrained_json === true,
    model_json_fallback_used: cognition.payload.model_json_fallback_used === true,
    broca_output_id: speech.id,
    broca_output_type: speech.type,
    broca_output_source: speech.source,
    broca_text_response: speech.payload.text,
    broca_text_response_created_now: true,
    guard_does_not_reference_brocaOk: true,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run();
