'use strict';

const {
  CHAT_MODE_LIVING_CONTRACT,
  normalizeWakeText,
  isAddressedToFloki,
  stripWakePhrase
} = require('./chat-mode-living-contract.cjs');

const WAKE_WORD_GATE_VERSION = 'floki-v2-wake-word-gate-v1';

const VALID_MODALITIES = Object.freeze([
  'typed',
  'spoken'
]);

const VALID_SOURCES = Object.freeze([
  'user',
  'background',
  'self_voice'
]);

function assertText(value, fieldName = 'text') {
  if (typeof value !== 'string') {
    throw new TypeError(fieldName + ' must be a string');
  }

  return value;
}

function normalizeModality(modality) {
  const chosen = String(modality || 'spoken').trim().toLowerCase();

  if (!VALID_MODALITIES.includes(chosen)) {
    throw new Error('invalid chat input modality: ' + chosen);
  }

  return chosen;
}

function normalizeSource(source) {
  const chosen = String(source || 'user').trim().toLowerCase();

  if (!VALID_SOURCES.includes(chosen)) {
    throw new Error('invalid chat input source: ' + chosen);
  }

  return chosen;
}

function punctuationTrim(text) {
  return String(text || '')
    .trim()
    .replace(/^[\s,.:;!?'"()\[\]{}-]+/, '')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function classifyWakeInput(input = {}, contract = CHAT_MODE_LIVING_CONTRACT) {
  const rawText = assertText(input.text || '', 'input.text');
  const modality = normalizeModality(input.modality || 'spoken');
  const source = normalizeSource(input.source || 'user');
  const voiceSpeaking = input.voice_speaking === true;
  const normalizedText = normalizeWakeText(rawText);

  if (!rawText.trim()) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WAKE_WORD_GATE_IGNORED',
      gate_version: WAKE_WORD_GATE_VERSION,
      gate_open: false,
      direct_request: false,
      attention_only: false,
      should_reply: false,
      should_remember_as_background: false,
      modality,
      source,
      reason: 'empty_input',
      raw_text: rawText,
      normalized_text: normalizedText,
      wake_phrase: contract.wake_gate.required_phrase,
      request_text: '',
      ears_must_be_muted: voiceSpeaking,
      chat_mode_only: true
    });
  }

  if (voiceSpeaking || source === 'self_voice') {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WAKE_WORD_GATE_SELF_ECHO_BLOCKED',
      gate_version: WAKE_WORD_GATE_VERSION,
      gate_open: false,
      direct_request: false,
      attention_only: false,
      should_reply: false,
      should_remember_as_background: false,
      modality,
      source,
      reason: voiceSpeaking ? 'voice_speaking_ears_muted' : 'self_voice_rejected',
      raw_text: rawText,
      normalized_text: normalizedText,
      wake_phrase: contract.wake_gate.required_phrase,
      request_text: '',
      ears_must_be_muted: true,
      chat_mode_only: true
    });
  }

  const addressed = isAddressedToFloki(rawText, contract);

  if (!addressed) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_WAKE_WORD_GATE_IGNORED',
      gate_version: WAKE_WORD_GATE_VERSION,
      gate_open: false,
      direct_request: false,
      attention_only: false,
      should_reply: false,
      should_remember_as_background: true,
      modality,
      source,
      reason: 'wake_phrase_missing',
      raw_text: rawText,
      normalized_text: normalizedText,
      wake_phrase: contract.wake_gate.required_phrase,
      request_text: '',
      ears_must_be_muted: false,
      chat_mode_only: true
    });
  }

  const stripped = punctuationTrim(stripWakePhrase(rawText, contract));
  const attentionOnly = stripped.length === 0;

  return Object.freeze({
    ok: true,
    marker: attentionOnly ? 'FLOKI_V2_WAKE_WORD_GATE_ATTENTION_ONLY' : 'FLOKI_V2_WAKE_WORD_GATE_OPEN',
    gate_version: WAKE_WORD_GATE_VERSION,
    gate_open: true,
    direct_request: !attentionOnly,
    attention_only: attentionOnly,
    should_reply: !attentionOnly,
    should_remember_as_background: false,
    modality,
    source,
    reason: attentionOnly ? 'wake_phrase_only' : 'wake_phrase_present',
    raw_text: rawText,
    normalized_text: normalizedText,
    wake_phrase: contract.wake_gate.required_phrase,
    request_text: stripped,
    ears_must_be_muted: false,
    chat_mode_only: true
  });
}

function shouldRouteToCognition(classification) {
  return Boolean(
    classification &&
    classification.ok === true &&
    classification.gate_open === true &&
    classification.direct_request === true &&
    classification.should_reply === true
  );
}

function buildWakeGatedUserText(input = {}) {
  const classification = classifyWakeInput(input);

  if (!shouldRouteToCognition(classification)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WAKE_WORD_GATE_NOT_ROUTED',
      classification,
      routed_to_cognition: false,
      user_text_for_cognition: '',
      chat_mode_only: true
    });
  }

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WAKE_WORD_GATE_ROUTED',
    classification,
    routed_to_cognition: true,
    user_text_for_cognition: classification.request_text,
    chat_mode_only: true
  });
}

function wakeWordGateStatus() {
  const open = classifyWakeInput({
    text: 'Hey Floki, can you hear me?',
    modality: 'spoken',
    source: 'user'
  });

  const ignored = classifyWakeInput({
    text: 'can you hear me?',
    modality: 'spoken',
    source: 'background'
  });

  const selfEcho = classifyWakeInput({
    text: 'Hey Floki, I am your own speaker output.',
    modality: 'spoken',
    source: 'self_voice',
    voice_speaking: true
  });

  const ok = open.gate_open === true &&
    open.direct_request === true &&
    ignored.gate_open === false &&
    ignored.should_reply === false &&
    selfEcho.gate_open === false &&
    selfEcho.ears_must_be_muted === true;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_WAKE_WORD_GATE_PASS' : 'FLOKI_V2_WAKE_WORD_GATE_FAIL',
    gate_version: WAKE_WORD_GATE_VERSION,
    wake_phrase: CHAT_MODE_LIVING_CONTRACT.wake_gate.required_phrase,
    typed_requires_wake_phrase: CHAT_MODE_LIVING_CONTRACT.wake_gate.typed_input_requires_wake_phrase,
    spoken_requires_wake_phrase: CHAT_MODE_LIVING_CONTRACT.wake_gate.spoken_input_requires_wake_phrase,
    addressed_input_routes_to_cognition: shouldRouteToCognition(open),
    unaddressed_input_ignored: ignored.should_reply === false,
    self_voice_blocked: selfEcho.gate_open === false,
    ears_muted_during_voice: selfEcho.ears_must_be_muted === true,
    chat_mode_only: true
  });
}

if (require.main === module) {
  const status = wakeWordGateStatus();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }
}

module.exports = {
  WAKE_WORD_GATE_VERSION,
  VALID_MODALITIES,
  VALID_SOURCES,
  assertText,
  normalizeModality,
  normalizeSource,
  punctuationTrim,
  classifyWakeInput,
  shouldRouteToCognition,
  buildWakeGatedUserText,
  wakeWordGateStatus
};
