'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const serviceSource = fs.readFileSync(
  path.join(root, 'src/vision/chat-webcam-vision-service.cjs'),
  'utf8'
);

const hybridSource = fs.readFileSync(
  path.join(root, 'src/vision/hybrid-detection-service.cjs'),
  'utf8'
);

const verifierSource = fs.readFileSync(
  path.join(root, 'src/vision/person-presence-verifier.cjs'),
  'utf8'
);

assert.match(
  serviceSource,
  /runHybridDetectionOnFrame/
);

assert.match(
  serviceSource,
  /stopHybridDetectionWorkers/
);

assert.match(
  serviceSource,
  /verifyDetectionFramePersons/
);

assert.match(
  serviceSource,
  /const\s+hybridResult\s*=\s*await\s+runHybridDetectionOnFrame\s*\(/
);

assert.match(
  serviceSource,
  /const\s+parsedFrame\s*=\s*parseYoloDetectionFrame\s*\(\s*hybridResult\s*,/
);

assert.match(
  serviceSource,
  /const\s+verifiedStored\s*=\s*storeDetectionResult\s*\(/
);

assert.match(
  hybridSource,
  /function\s+runHybridDetectionOnFrame/
);

assert.match(
  verifierSource,
  /cropFrameBufferFromBuffer/
);

assert.match(
  verifierSource,
  /candidate_index/
);

assert.match(
  verifierSource,
  /classification/
);

assert.doesNotMatch(
  verifierSource,
  /Image 1 is the complete current webcam frame/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_HYBRID_VISION_STACK_CONTRACT_PASS',
  hybrid_detection_entrypoint_wired: true,
  hybrid_workers_have_shutdown_path: true,
  parsed_hybrid_frame_persisted: true,
  verified_frame_persisted: true,
  crop_verifier_wired: true,
  obsolete_full_frame_prompt_required: false,
  live_services_started: false
}, null, 2));
