'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verifier = require(
  path.join(
    root,
    'src/vision/person-presence-verifier.cjs'
  )
);

const detections = [
  {
    id: 'main-person',
    class_id: 0,
    type: 'object',
    label: 'person',
    confidence: 0.9433,
    source: 'yolo',
    proposal_sources: [
      'yolo',
      'grounding_dino'
    ],
    bbox: {
      x: 0.285535,
      y: 0.206131,
      width: 0.508287,
      height: 0.779554
    }
  },
  {
    id: 'wife-yolo',
    class_id: 0,
    type: 'object',
    label: 'person',
    confidence: 0.3281,
    source: 'yolo',
    proposal_sources: ['yolo'],
    bbox: {
      x: 0.648162,
      y: 0.449976,
      width: 0.121899,
      height: 0.196412
    }
  },
  {
    id: 'wife-dino',
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence: 0.328611,
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino'],
    bbox: {
      x: 0.642163,
      y: 0.427238,
      width: 0.144219,
      height: 0.469944
    }
  },
  {
    id: 'wall-photo-person',
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence: 0.251206,
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino'],
    bbox: {
      x: 0.562005,
      y: 0.21238,
      width: 0.031777,
      height: 0.077077
    }
  },
  {
    id: 'left-wall-person',
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence: 0.303814,
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino'],
    bbox: {
      x: 0.030373,
      y: 0.197422,
      width: 0.080288,
      height: 0.163121
    }
  }
];

const groups =
  verifier.buildPersonCandidateGroups(detections);
const selected =
  verifier.selectPersonCandidateGroups(detections);

assert.equal(groups.length, 4);
assert.equal(selected.length, 2);

assert.deepEqual(
  selected[0].originalDetections.map(
    (detection) => detection.id
  ),
  ['main-person']
);

assert.deepEqual(
  selected[1].originalDetections.map(
    (detection) => detection.id
  ).sort(),
  ['wife-dino', 'wife-yolo']
);

assert.equal(
  selected.some((group) =>
    group.originalDetections.some(
      (detection) =>
        detection.id === 'wall-photo-person' ||
        detection.id === 'left-wall-person'
    )
  ),
  false
);

const rawPersonDisposition =
  verifier.classifyVerifiedDetectionForDisplay({
    ...detections[0],
    proposal_sources: ['yolo']
  });

assert.equal(
  rawPersonDisposition.bucket,
  'suppressed'
);

const consensusPersonDisposition =
  verifier.classifyVerifiedDetectionForDisplay({
    ...detections[0],
    proposal_sources: ['yolo', 'grounding_dino']
  });

assert.equal(
  consensusPersonDisposition.bucket,
  'persons'
);

const dinoOnlyWallObject = {
  id: 'wall-mobile-phone',
  class_id: 1000,
  type: 'object',
  label: 'a mobile phone',
  confidence: 0.37,
  source: 'grounding_dino',
  proposal_sources: ['grounding_dino'],
  bbox: {
    x: 0.03,
    y: 0.19,
    width: 0.08,
    height: 0.16
  }
};

assert.equal(
  verifier.classifyVerifiedDetectionForDisplay(
    dinoOnlyWallObject
  ).bucket,
  'objects'
);

const yoloChair = {
  id: 'chair',
  class_id: 56,
  type: 'object',
  label: 'chair',
  confidence: 0.55,
  source: 'yolo',
  proposal_sources: ['yolo'],
  bbox: {
    x: 0.18,
    y: 0.53,
    width: 0.19,
    height: 0.45
  }
};

assert.equal(
  verifier.classifyVerifiedDetectionForDisplay(
    yoloChair
  ).bucket,
  'objects'
);

verifier.clearPersonVerificationCache();

const verifiedLivePerson = Object.freeze({
  candidate_index: 0,
  classification: 'live_person',
  confidence: 0.99,
  depiction_type: 'none',
  short_basis:
    'three-dimensional person physically present',
  verifier_ok: true
});

assert.equal(
  verifier.rememberSuccessfulVerification(
    detections[0],
    verifiedLivePerson
  ),
  true
);

const nextFrame = {
  schema_version: 1,
  detections: [
    {
      ...detections[0],
      id: 'main-person-next-frame',
      visual_fingerprint: null,
      bbox: {
        x: 0.30,
        y: 0.21,
        width: 0.49,
        height: 0.77
      }
    }
  ]
};

const attached =
  verifier.attachCachedPersonVerifications(
    nextFrame
  );

assert.equal(
  attached.detections[0].verification.classification,
  'live_person'
);

assert.equal(
  attached.detections[0].verification.cache_source,
  'spatial_track'
);

assert.equal(
  verifier.classifyVerifiedDetectionForDisplay(
    attached.detections[0]
  ).bucket,
  'persons'
);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_LIVE_PERSON_ROUTING_REGRESSION_PASS',
  real_person_groups_selected: 2,
  wife_duplicate_proposals_grouped: true,
  small_wall_person_proposals_selected: false,
  dino_only_wall_objects_visible: true,
  consensus_person_visible_while_verifier_recovers: true,
  raw_person_fallback_visible: false,
  verified_person_track_cache: true,
  live_services_started: false
}, null, 2));
