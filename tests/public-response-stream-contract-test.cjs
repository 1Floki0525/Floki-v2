'use strict';
const assert = require('node:assert/strict');
const { extractCompletedFirstPublicField, firstCompleteSentence, createReleaseGate, containsPrivateReasoningMarker } = require('../src/chat/public-response-stream.cjs');

assert.deepEqual(extractCompletedFirstPublicField('{"response_intent_for_broca":"Hello'), { complete: false, status: 'incomplete', reason: 'unterminated_json_string' });
assert.equal(extractCompletedFirstPublicField('{"safe_thought_summary":"private","response_intent_for_broca":"Hello."}').status, 'frame_mismatch');
assert.equal(extractCompletedFirstPublicField('{"response_intent_for_broca":"<think>private reasoning</think>",').status, 'unsafe');
const complete = extractCompletedFirstPublicField('{"response_intent_for_broca":"I can see the room safely.","safe_thought_summary":"private"}');
assert.equal(complete.complete, true);
assert.equal(complete.value, 'I can see the room safely.');
assert.equal(firstCompleteSentence('I can see the room. I am still observing.'), 'I can see the room.');
assert.equal(containsPrivateReasoningMarker('<think>secret</think>'), true);

let publicCount = 0;
const gate = createReleaseGate({
  minimum_sentence_characters: 8,
  authorize(text) { return { payload: { text: String(text).trim() } }; },
  on_public_text() { publicCount += 1; }
});
assert.equal(gate.release('I am responding now.').released, true);
assert.equal(gate.release('I am duplicated.').duplicate, true);
assert.equal(publicCount, 1);
console.log('public-response-stream-contract-test PASS');
