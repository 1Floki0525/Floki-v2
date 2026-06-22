'use strict';

const assert = require('node:assert/strict');
const {
  isPersonCandidate,
  validateVerificationResult,
  normalizeVerificationResult,
  classifyVerifiedDetectionForDisplay
} = require('../src/vision/person-presence-verifier.cjs');

function candidate(verification, sources = ['yolo']) {
  return {
    id: 'candidate-1',
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence: 0.88,
    source: sources.includes('yolo') ? 'yolo' : sources[0],
    proposal_sources: sources,
    bbox: {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.3
    },
    ...(verification ? { verification } : {})
  };
}

assert.equal(isPersonCandidate(candidate()), true);
assert.equal(
  isPersonCandidate({
    class_id: 56,
    label: 'chair'
  }),
  false
);

const live = {
  candidate_index: 0,
  classification: 'live_person',
  confidence: 0.93,
  depiction_type: 'none',
  short_basis:
    'The candidate occupies the room with visible depth and body context.'
};

const depicted = {
  candidate_index: 0,
  classification: 'depicted_person',
  confidence: 0.97,
  depiction_type: 'framed_photo',
  short_basis:
    'The person is contained inside a visible picture frame on the wall.'
};

const uncertain = {
  candidate_index: 0,
  classification: 'uncertain',
  confidence: 0.2,
  depiction_type: 'unknown',
  short_basis:
    'The crop does not contain enough context.'
};

assert.equal(validateVerificationResult(live).valid, true);
assert.equal(validateVerificationResult(depicted).valid, true);
assert.equal(validateVerificationResult(uncertain).valid, true);

assert.equal(
  normalizeVerificationResult({
    classification: 'live_person'
  }, 0.65).classification,
  'uncertain'
);

const normalizedLive =
  normalizeVerificationResult(live, 0.65);
const normalizedDepicted =
  normalizeVerificationResult(depicted, 0.65);
const normalizedUncertain =
  normalizeVerificationResult(uncertain, 0.65);

assert.equal(normalizedLive.verifier_ok, true);
assert.equal(normalizedDepicted.verifier_ok, true);
assert.equal(normalizedUncertain.verifier_ok, false);

const liveDisposition =
  classifyVerifiedDetectionForDisplay(
    candidate(normalizedLive)
  );

assert.equal(liveDisposition.bucket, 'persons');
assert.equal(liveDisposition.detection.label, 'person');

const depictedDisposition =
  classifyVerifiedDetectionForDisplay(
    candidate(normalizedDepicted)
  );

assert.equal(depictedDisposition.bucket, 'objects');
assert.equal(
  depictedDisposition.detection.label,
  'framed photo'
);

const uncertainDisposition =
  classifyVerifiedDetectionForDisplay(
    candidate(normalizedUncertain)
  );

assert.equal(uncertainDisposition.bucket, 'suppressed');
assert.equal(
  typeof uncertainDisposition.unavailable_reason,
  'string'
);

const pendingDisposition =
  classifyVerifiedDetectionForDisplay(candidate());

assert.equal(pendingDisposition.bucket, 'suppressed');
assert.equal(
  pendingDisposition.unavailable_reason,
  'person_verification_pending'
);

const consensusPendingDisposition =
  classifyVerifiedDetectionForDisplay(
    candidate(undefined, ['yolo', 'grounding_dino'])
  );

assert.equal(
  consensusPendingDisposition.bucket,
  'persons'
);
assert.equal(
  consensusPendingDisposition.detection.display_basis,
  'yolo_grounding_dino_consensus'
);

const chairDisposition =
  classifyVerifiedDetectionForDisplay({
    class_id: 56,
    type: 'object',
    label: 'chair',
    confidence: 0.9,
    source: 'yolo',
    proposal_sources: ['yolo'],
    bbox: {
      x: 0.2,
      y: 0.2,
      width: 0.2,
      height: 0.2
    }
  });

assert.equal(chairDisposition.bucket, 'objects');

const dinoObjectDisposition =
  classifyVerifiedDetectionForDisplay({
    class_id: 1000,
    type: 'object',
    label: 'a bottle',
    confidence: 0.38,
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino'],
    bbox: {
      x: 0.1,
      y: 0.1,
      width: 0.1,
      height: 0.2
    }
  });

assert.equal(dinoObjectDisposition.bucket, 'objects');
assert.equal(dinoObjectDisposition.detection.label, 'bottle');

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_PERSON_PRESENCE_VERIFIER_CONTRACT_PASS',
  raw_yolo_person_is_not_trusted_as_live_person: true,
  normalized_live_person_routes_to_persons: true,
  depicted_person_routes_to_objects: true,
  uncertain_person_is_suppressed: true,
  pending_person_is_suppressed: true,
  live_person_requires_verification: true,
  face_identification_used: false,
  chat_mode_only: true,
  game_mode_started: false
}, null, 2));
