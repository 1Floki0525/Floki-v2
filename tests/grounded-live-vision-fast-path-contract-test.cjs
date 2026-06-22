'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/runtime/chat-local-runtime.cjs'), 'utf8');
const visionSource = fs.readFileSync(path.join(root, 'src/vision/chat-webcam-vision-service.cjs'), 'utf8');
const yamlSource = fs.readFileSync(path.join(root, 'config/chat.config.yaml'), 'utf8');

const { getVisionConfig } = require('../src/config/floki-config.cjs');
const {
  configuredVisionQuestionPhrases,
  looksLikeVisionQuestion,
  buildGroundedVisionReply,
  visionObservationTimestamp
} = require('../src/runtime/chat-local-runtime.cjs');

const vision = getVisionConfig('chat');
assert.equal(vision.direct_answer_enabled, true);
assert.equal(vision.direct_answer_prefer_detection, true);
assert.ok(vision.direct_answer_max_age_ms > 0);
assert.ok(vision.direct_answer_wait_ms > 0);
assert.equal(Array.isArray(vision.direct_question_phrases), false);
assert.ok(Object.keys(vision.direct_question_phrases).length >= 4);
assert.ok(configuredVisionQuestionPhrases(vision).length >= 4);
assert.equal(looksLikeVisionQuestion('Hey Floki, what can you see?', vision), true);
assert.equal(looksLikeVisionQuestion('Please tell me a joke.', vision), false);

const summary = 'Current live detector view: one person; one chair.';
const grounded = buildGroundedVisionReply({
  available: true,
  fresh: true,
  source: 'webcam_live_detection',
  observation_summary: summary
}, vision);
assert.equal(grounded, vision.direct_answer_prefix + summary);
assert.equal(grounded.includes('text-based chat interface'), false);
assert.equal(
  visionObservationTimestamp({ latest_private_observation_timestamp: '2026-06-22T16:40:00.000Z' }),
  '2026-06-22T16:40:00.000Z'
);

const unavailable = buildGroundedVisionReply({
  available: false,
  fresh: false,
  observation_summary: null
}, vision);
assert.equal(unavailable, vision.direct_answer_unavailable_reply);

assert.match(yamlSource, /direct_question_phrases:/);
assert.match(runtimeSource, /FLOKI_V2_GROUNDED_LIVE_VISION_REPLY/);
assert.match(runtimeSource, /recordGroundedVisionTurn/);
assert.match(runtimeSource, /prefer_detection: visionConfig\.direct_answer_prefer_detection === true/);
assert.doesNotMatch(runtimeSource, /what do you see/i);
assert.match(visionSource, /options\.prefer_detection === true/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V13_GROUNDED_LIVE_VISION_FAST_PATH_PASS',
  node_version: process.version,
  yaml_only_vision_question_phrases: true,
  structured_detection_preferred: true,
  direct_vision_model_invention_blocked: true,
  live_runtime_started: false
}, null, 2));
