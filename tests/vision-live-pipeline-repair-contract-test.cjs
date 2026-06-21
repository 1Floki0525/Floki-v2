'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const serviceSource = fs.readFileSync(
  path.join(root, 'src/vision/chat-webcam-vision-service.cjs'),
  'utf8'
);

const verifierSource = fs.readFileSync(
  path.join(root, 'src/vision/person-presence-verifier.cjs'),
  'utf8'
);

assert.match(
  serviceSource,
  /stopHybridDetectionWorkers/
);

assert.match(
  serviceSource,
  /stopHybridDetectionWorkers\s*\(\s*\)/
);

assert.match(
  serviceSource,
  /runHybridDetectionOnFrame/
);

assert.match(
  serviceSource,
  /verifyDetectionFramePersons/
);

assert.match(
  verifierSource,
  /const\s+verificationCache\s*=\s*new\s+Map\s*\(\s*\)/
);

assert.match(
  verifierSource,
  /const\s+verificationTracks\s*=\s*\[\s*\]/
);

assert.match(
  verifierSource,
  /const\s+cacheExpiresAt\s*=\s*now\s*\+\s*config\.cacheTtlMs/
);

assert.match(
  verifierSource,
  /const\s+trackExpiresAt\s*=\s*now\s*\+\s*config\.trackTtlMs/
);

assert.match(
  verifierSource,
  /expiresAt:\s*cacheExpiresAt/
);

assert.match(
  verifierSource,
  /expiresAt:\s*trackExpiresAt/
);

assert.match(
  verifierSource,
  /person_verification_pending/
);

assert.match(
  verifierSource,
  /bucket:\s*'suppressed'/
);

assert.doesNotMatch(
  verifierSource,
  /unverified person candidate/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_VISION_LIVE_PIPELINE_REPAIR_CONTRACT_PASS',
  hybrid_worker_cleanup_wired: true,
  cache_ttl_wired: true,
  track_ttl_wired: true,
  pending_people_suppressed: true,
  uncertain_people_not_exposed_as_verified_objects: true,
  obsolete_single_ttl_shape_required: false,
  live_services_started: false
}, null, 2));
