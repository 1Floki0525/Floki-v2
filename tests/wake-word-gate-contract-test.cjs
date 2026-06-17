'use strict';

const assert = require('node:assert/strict');

const {
  WAKE_WORD_GATE_VERSION,
  normalizeModality,
  normalizeSource,
  punctuationTrim,
  classifyWakeInput,
  shouldRouteToCognition,
  buildWakeGatedUserText,
  wakeWordGateStatus
} = require('../src/chat/wake-word-gate.cjs');

function run() {
  assert.equal(WAKE_WORD_GATE_VERSION, 'floki-v2-wake-word-gate-v1');

  assert.equal(normalizeModality('spoken'), 'spoken');
  assert.equal(normalizeModality('typed'), 'typed');
  assert.throws(() => normalizeModality('vision'), /invalid chat input modality/);

  assert.equal(normalizeSource('user'), 'user');
  assert.equal(normalizeSource('background'), 'background');
  assert.equal(normalizeSource('self_voice'), 'self_voice');
  assert.throws(() => normalizeSource('unknown'), /invalid chat input source/);

  assert.equal(punctuationTrim(' , hey there!  '), 'hey there!');

  const spokenOpen = classifyWakeInput({
    text: 'Hey Floki, can you hear Binary-God?',
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(spokenOpen.ok, true);
  assert.equal(spokenOpen.marker, 'FLOKI_V2_WAKE_WORD_GATE_OPEN');
  assert.equal(spokenOpen.gate_open, true);
  assert.equal(spokenOpen.direct_request, true);
  assert.equal(spokenOpen.should_reply, true);
  assert.equal(spokenOpen.request_text, 'can you hear Binary-God?');
  assert.equal(spokenOpen.chat_mode_only, true);
  assert.equal(shouldRouteToCognition(spokenOpen), true);

  const typedOpen = classifyWakeInput({
    text: 'HEY FLOKI remember this for later',
    modality: 'typed',
    source: 'user'
  });

  assert.equal(typedOpen.gate_open, true);
  assert.equal(typedOpen.direct_request, true);
  assert.equal(typedOpen.request_text, 'remember this for later');
  assert.equal(shouldRouteToCognition(typedOpen), true);

  const attentionOnly = classifyWakeInput({
    text: 'hey Floki',
    modality: 'spoken',
    source: 'user'
  });

  assert.equal(attentionOnly.marker, 'FLOKI_V2_WAKE_WORD_GATE_ATTENTION_ONLY');
  assert.equal(attentionOnly.gate_open, true);
  assert.equal(attentionOnly.direct_request, false);
  assert.equal(attentionOnly.attention_only, true);
  assert.equal(attentionOnly.should_reply, false);
  assert.equal(shouldRouteToCognition(attentionOnly), false);

  const missingWake = classifyWakeInput({
    text: 'can you hear me?',
    modality: 'spoken',
    source: 'background'
  });

  assert.equal(missingWake.marker, 'FLOKI_V2_WAKE_WORD_GATE_IGNORED');
  assert.equal(missingWake.gate_open, false);
  assert.equal(missingWake.direct_request, false);
  assert.equal(missingWake.should_reply, false);
  assert.equal(missingWake.should_remember_as_background, true);
  assert.equal(missingWake.reason, 'wake_phrase_missing');
  assert.equal(shouldRouteToCognition(missingWake), false);

  const typedMissingWake = classifyWakeInput({
    text: 'Floki can you hear me?',
    modality: 'typed',
    source: 'user'
  });

  assert.equal(typedMissingWake.gate_open, false);
  assert.equal(typedMissingWake.should_reply, false);
  assert.equal(typedMissingWake.reason, 'wake_phrase_missing');

  const selfVoice = classifyWakeInput({
    text: 'Hey Floki, this came from your own voice output.',
    modality: 'spoken',
    source: 'self_voice'
  });

  assert.equal(selfVoice.marker, 'FLOKI_V2_WAKE_WORD_GATE_SELF_ECHO_BLOCKED');
  assert.equal(selfVoice.gate_open, false);
  assert.equal(selfVoice.ears_must_be_muted, true);
  assert.equal(selfVoice.should_reply, false);
  assert.equal(selfVoice.reason, 'self_voice_rejected');

  const speaking = classifyWakeInput({
    text: 'Hey Floki, do not hear yourself.',
    modality: 'spoken',
    source: 'user',
    voice_speaking: true
  });

  assert.equal(speaking.marker, 'FLOKI_V2_WAKE_WORD_GATE_SELF_ECHO_BLOCKED');
  assert.equal(speaking.gate_open, false);
  assert.equal(speaking.ears_must_be_muted, true);
  assert.equal(speaking.reason, 'voice_speaking_ears_muted');

  const routed = buildWakeGatedUserText({
    text: 'Hey Floki, tell me what you remember.',
    modality: 'typed',
    source: 'user'
  });

  assert.equal(routed.ok, true);
  assert.equal(routed.marker, 'FLOKI_V2_WAKE_WORD_GATE_ROUTED');
  assert.equal(routed.routed_to_cognition, true);
  assert.equal(routed.user_text_for_cognition, 'tell me what you remember.');

  const notRouted = buildWakeGatedUserText({
    text: 'tell me what you remember.',
    modality: 'typed',
    source: 'user'
  });

  assert.equal(notRouted.ok, false);
  assert.equal(notRouted.marker, 'FLOKI_V2_WAKE_WORD_GATE_NOT_ROUTED');
  assert.equal(notRouted.routed_to_cognition, false);
  assert.equal(notRouted.user_text_for_cognition, '');

  const empty = classifyWakeInput({
    text: '',
    modality: 'typed',
    source: 'user'
  });

  assert.equal(empty.reason, 'empty_input');
  assert.equal(empty.gate_open, false);
  assert.equal(empty.should_reply, false);

  const status = wakeWordGateStatus();

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_WAKE_WORD_GATE_PASS');
  assert.equal(status.wake_phrase, 'hey floki');
  assert.equal(status.typed_requires_wake_phrase, true);
  assert.equal(status.spoken_requires_wake_phrase, true);
  assert.equal(status.addressed_input_routes_to_cognition, true);
  assert.equal(status.unaddressed_input_ignored, true);
  assert.equal(status.self_voice_blocked, true);
  assert.equal(status.ears_muted_during_voice, true);
  assert.equal(status.chat_mode_only, true);

  console.log(JSON.stringify(status, null, 2));
}

run();
