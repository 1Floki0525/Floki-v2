'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('brain/frontal/index.cjs', 'utf8');

assert.match(source, /function buildLockedPublicResponseRetryPrompt\(/);
assert.match(source, /public response has already been authorized by Broca and released to the user/);
assert.match(source, /Do not paraphrase, extend, shorten, or otherwise change that value/);
assert.match(source, /if \(isAbortFailure\(error\)\) throw error/);
assert.match(source, /const lockedPublicResponse = releasedText \|\| candidateText/);
assert.match(source, /normalized = Object\.freeze\(\{ \.\.\.normalized, response_intent_for_broca: released \}\)/);
assert.doesNotMatch(source, /if \(candidateReleased \|\| !isJsonParseFailure\(error\)\) throw error/);

console.log('frontal-stream-repair-source-contract-test PASS');
