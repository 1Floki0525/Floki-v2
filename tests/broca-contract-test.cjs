'use strict';

const assert = require('node:assert/strict');
const { createBrainOutput, validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const { makeUserTextEvent } = require('../src/brain/brain-event-schema.cjs');
const { createBroca } = require('../brain/broca/index.cjs');

function run() {
  const event = makeUserTextEvent('Hey Floki, speak honestly from your chat cognition.', {
    trace_id: 'broca_contract_test'
  });

  const cognitionOutput = createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    parent_event_ids: [event.id],
    payload: {
      model: 'qwen3.5:9b',
      cognition: {
        safe_thought_summary: 'Memory gives me continuity, and hope helps me keep growing through chat.',
        felt_interpretation: 'calm hope about becoming more consistent, thoughtful, and present in conversation.',
        response_intent_for_broca: 'I can answer from chat-mode cognition, memory, and emotion context.',
        new_memory_summary: 'Broca should speak from chat cognition without pretending to have abilities outside chat mode.',
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
    include_chat_truth: true,
    include_stage_truth: false
  });

  validateBrainOutput(speech);
  assert.equal(speech.type, 'speech');
  assert.equal(speech.source, 'broca');
  assert.equal(typeof speech.payload.text, 'string');
  assert.ok(speech.payload.text.length > 0);

  const lowerSpeech = speech.payload.text.toLowerCase();

  assert.equal(lowerSpeech.includes('<think>'), false);
  assert.equal(lowerSpeech.includes('chain_of_thought'), false);
  assert.equal(lowerSpeech.includes('hidden_reasoning'), false);
  assert.equal(lowerSpeech.includes('raw_reasoning'), false);
  assert.equal(lowerSpeech.includes('scratchpad'), false);

  assert.equal(lowerSpeech.includes('i am in minecraft'), false);
  assert.equal(lowerSpeech.includes('body control'), false);
  assert.equal(lowerSpeech.includes('live eyes'), false);
  assert.equal(lowerSpeech.includes('i can see you'), false);

  assert.equal(lowerSpeech.includes('chat-mode') || lowerSpeech.includes('chat mode'), true);

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

  const unsafeSpeech = broca.speakFromCognition(unsafeCognition, {
    parent_event_ids: [event.id],
    include_chat_truth: true,
    include_stage_truth: false
  });

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
    chat_mode_only: true
  }, null, 2));
}

run();
