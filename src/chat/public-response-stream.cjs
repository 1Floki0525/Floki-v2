'use strict';

const PRIVATE_MARKERS = Object.freeze([
  '<think>', '</think>', 'chain_of_thought', 'hidden_reasoning', 'raw_reasoning', 'scratchpad'
]);

function containsPrivateReasoningMarker(value) {
  const lower = String(value || '').toLowerCase();
  return PRIVATE_MARKERS.some((marker) => lower.includes(marker));
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function readJsonString(text, startIndex) {
  if (text[startIndex] !== '"') {
    return Object.freeze({ status: 'malformed', reason: 'expected_json_string', end_index: startIndex });
  }

  let escaped = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const raw = text.slice(startIndex, index + 1);
      try {
        return Object.freeze({
          status: 'complete',
          value: JSON.parse(raw),
          raw,
          end_index: index + 1
        });
      } catch (error) {
        return Object.freeze({ status: 'malformed', reason: 'invalid_json_string:' + error.message, end_index: index + 1 });
      }
    }
    if (character.charCodeAt(0) < 0x20) {
      return Object.freeze({ status: 'malformed', reason: 'control_character_in_json_string', end_index: index });
    }
  }

  return Object.freeze({ status: 'incomplete', reason: 'unterminated_json_string', end_index: text.length });
}

function extractCompletedFirstPublicField(buffer, fieldName = 'response_intent_for_broca') {
  const text = String(buffer || '');
  let cursor = skipWhitespace(text, 0);
  if (cursor >= text.length) return Object.freeze({ complete: false, status: 'incomplete', reason: 'empty' });
  if (text[cursor] !== '{') return Object.freeze({ complete: false, status: 'malformed', reason: 'object_must_start_with_brace' });
  cursor = skipWhitespace(text, cursor + 1);

  const keyResult = readJsonString(text, cursor);
  if (keyResult.status !== 'complete') {
    return Object.freeze({ complete: false, status: keyResult.status, reason: keyResult.reason });
  }
  if (keyResult.value !== fieldName) {
    return Object.freeze({ complete: false, status: 'frame_mismatch', reason: 'public_field_not_first', actual_first_field: keyResult.value });
  }

  cursor = skipWhitespace(text, keyResult.end_index);
  if (cursor >= text.length) return Object.freeze({ complete: false, status: 'incomplete', reason: 'missing_colon' });
  if (text[cursor] !== ':') return Object.freeze({ complete: false, status: 'malformed', reason: 'missing_colon' });
  cursor = skipWhitespace(text, cursor + 1);

  const valueResult = readJsonString(text, cursor);
  if (valueResult.status !== 'complete') {
    return Object.freeze({ complete: false, status: valueResult.status, reason: valueResult.reason });
  }

  cursor = skipWhitespace(text, valueResult.end_index);
  if (cursor >= text.length) return Object.freeze({ complete: false, status: 'incomplete', reason: 'field_terminator_not_received' });
  if (text[cursor] !== ',' && text[cursor] !== '}') {
    return Object.freeze({ complete: false, status: 'malformed', reason: 'invalid_field_terminator' });
  }

  const value = String(valueResult.value || '').trim();
  if (!value) return Object.freeze({ complete: false, status: 'malformed', reason: 'empty_public_field' });
  if (containsPrivateReasoningMarker(value)) {
    return Object.freeze({ complete: false, status: 'unsafe', reason: 'private_reasoning_marker' });
  }

  return Object.freeze({
    complete: true,
    status: 'complete',
    field_name: fieldName,
    value,
    field_end_index: valueResult.end_index,
    object_continues: text[cursor] === ','
  });
}

function firstCompleteSentence(text, minimumCharacters = 8) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const min = Math.max(1, Number(minimumCharacters || 1));
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '.' && character !== '!' && character !== '?') continue;
    const next = value[index + 1];
    if (next && !/\s/.test(next)) continue;
    const sentence = value.slice(0, index + 1).trim();
    if (sentence.length >= min) return sentence;
  }
  return null;
}

function createReleaseGate(options = {}) {
  let released = false;
  let authorizedText = null;
  let firstSentence = null;

  function release(candidate, context = {}) {
    if (released) return Object.freeze({ released: false, duplicate: true, text: authorizedText, first_sentence: firstSentence });
    if (options.signal && options.signal.aborted) return Object.freeze({ released: false, interrupted: true });
    if (typeof options.authorize !== 'function') throw new Error('public response release gate requires Broca authorization');

    const authorization = options.authorize(candidate, context);
    const text = authorization && authorization.payload && typeof authorization.payload.text === 'string'
      ? authorization.payload.text.trim()
      : '';
    if (!text) throw new Error('Broca did not authorize public text');

    firstSentence = firstCompleteSentence(text, options.minimum_sentence_characters || 8) || text;
    authorizedText = text;
    released = true;

    if (typeof options.on_public_text === 'function') options.on_public_text(Object.freeze({ text, authorization }));
    if (typeof options.on_first_sentence === 'function') options.on_first_sentence(Object.freeze({ text: firstSentence, authorization }));

    return Object.freeze({ released: true, text, first_sentence: firstSentence, authorization });
  }

  return Object.freeze({
    release,
    was_released: () => released,
    authorized_text: () => authorizedText,
    first_sentence: () => firstSentence
  });
}

module.exports = {
  PRIVATE_MARKERS,
  containsPrivateReasoningMarker,
  readJsonString,
  extractCompletedFirstPublicField,
  firstCompleteSentence,
  createReleaseGate
};
