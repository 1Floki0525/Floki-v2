'use strict';

const assert = require('node:assert/strict');

const { createBrainOutput, validateBrainOutput } = require('../src/brain/brain-output-schema.cjs');
const {
  buildCognitionPrompt,
  buildCognitionRetryPrompt
} = require('../brain/frontal/index.cjs');
const {
  THIRD_PERSON_SELF_REFERENCE_CODE,
  isThirdPersonSelfReference,
  rejectThirdPersonSelfReference,
  composeSpeech,
  speakFromCognition
} = require('../brain/broca/index.cjs');

function makeCognitionOutput(responseIntent) {
  return createBrainOutput({
    type: 'model_response_summary',
    source: 'frontal',
    payload: {
      model: 'voice-fixture-model:test',
      cognition: {
        safe_thought_summary: 'I can answer from memory, trust, hope, and chat-mode continuity.',
        felt_interpretation: '',
        memory_links: [
          'The user asked about trust and hope.'
        ],
        personality_implications: [
          'Careful first-person speech supports coherent identity.'
        ],
        identity_implications: [
          'Chat-mode continuity should be spoken as I/me/my.'
        ],
        response_intent_for_broca: responseIntent,
        new_memory_summary: 'The first-person voice contract matters for spoken chat output.',
        emotion_reflection_enabled: true
      },
      safe_summary_only: true,
      raw_private_reasoning_stored: false,
      normalized_model_json: true,
      schema_constrained_json: true,
      model_json_fallback_used: false
    },
    diagnostics: {
      module: 'frontal',
      status: 'first_person_voice_contract_fixture'
    }
  });
}

function assertAllowed(text) {
  assert.equal(isThirdPersonSelfReference(text), false, text);
  assert.equal(rejectThirdPersonSelfReference(text), true, text);
}

function assertRejected(text) {
  assert.equal(isThirdPersonSelfReference(text), true, text);
  assert.throws(() => {
    rejectThirdPersonSelfReference(text);
  }, (error) => error && error.code === THIRD_PERSON_SELF_REFERENCE_CODE);
}

function run() {
  const prompt = buildCognitionPrompt({
    event: {
      payload: {
        text: 'Hey Floki, what do you remember about trust and hope?'
      }
    }
  });
  const retryPrompt = buildCognitionRetryPrompt({}, 'previous response used third-person self-talk');

  for (const builtPrompt of [prompt, retryPrompt]) {
    assert.equal(builtPrompt.includes('direct first-person speech from Floki to the user'), true);
    assert.equal(builtPrompt.includes('Use I/me/my/we where appropriate'), true);
    assert.equal(builtPrompt.includes('Do not write about Floki in third person'), true);
    assert.equal(builtPrompt.includes('Do not begin with "Floki..."'), true);
  }

  [
    'I remember that trust and hope matter to me.',
    'My memory connects that to our earlier conversation.',
    'I’m Floki, and I’m here with you.',
    'When you say Hey Floki, I know you are addressing me.'
  ].forEach(assertAllowed);

  [
    'Floki remembers that trust and hope matter.',
    'Floki feels calm about this.',
    'Floki’s memory connects this to trust.',
    'As Floki, the response should be careful.',
    'Floki remembers his earlier conversation.',
    'I’m Floki, and Floki remembers that trust matters.'
  ].forEach(assertRejected);

  const rejectedSpeech = speakFromCognition(
    makeCognitionOutput('Floki remembers that trust and hope matter.'),
    {},
    { persist_diagnostics: false }
  );

  validateBrainOutput(rejectedSpeech);
  assert.equal(rejectedSpeech.type, 'failure');
  assert.equal(rejectedSpeech.source, 'broca');
  assert.equal(rejectedSpeech.failure.code, THIRD_PERSON_SELF_REFERENCE_CODE);

  const goodCognition = makeCognitionOutput('I remember that trust and hope matter to me.');
  const composed = composeSpeech(goodCognition);

  assert.equal(composed, 'I remember that trust and hope matter to me.');
  assert.equal(isThirdPersonSelfReference(composed), false);
  assert.equal(/\b(?:I|me|my)\b/i.test(composed), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_FIRST_PERSON_VOICE_CONTRACT_PASS',
    good_first_person_passed: true,
    third_person_self_reference_rejected: true,
    broca_failure_code: rejectedSpeech.failure.code,
    composed_speech: composed,
    qwen_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    whisper_transcription_run_now: false,
    chat_mode_only: true
  }, null, 2));
}

run();
