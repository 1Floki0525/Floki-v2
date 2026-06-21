'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(
  path.join(root, 'src/vision/chat-webcam-vision-service.cjs'),
  'utf8'
);
const verifier = fs.readFileSync(
  path.join(root, 'src/vision/person-presence-verifier.cjs'),
  'utf8'
);
const yolo = fs.readFileSync(
  path.join(root, 'src/vision/yolo-detection-service.cjs'),
  'utf8'
);
const yaml = fs.readFileSync(
  path.join(root, 'config/chat.config.yaml'),
  'utf8'
);

assert.match(service, /detection_source:\s*'live_mjpeg_frame_buffer'/);
assert.match(service, /detector_schedule:\s*'time_based_latest_live_frame'/);
assert.match(service, /person_verifier_payload_mode:\s*'crop_only'/);
assert.match(service, /const frameSnapshot = Buffer\.from\(frame\)/);
assert.match(service, /chat-webcam-vision\.detect-/);
assert.match(service, /const minimumIntervalMs = Math\.max/);
assert.match(service, /maybeDetect\(latestFrame\);[\s\S]*maybeInfer\(latestFrame\);/);
assert.doesNotMatch(service, /await\s+maybeDetect\(latestFrame\)/);

const verifierCallStart = verifier.indexOf('async function callBatchVerifier(');
const verifierCallEnd = verifier.indexOf('async function verifyDetectionFramePersons(', verifierCallStart);
assert.ok(verifierCallStart >= 0 && verifierCallEnd > verifierCallStart);
const verifierCall = verifier.slice(verifierCallStart, verifierCallEnd);
assert.match(verifierCall, /candidate\.cropBuffer\.toString\('base64'\)/);
assert.doesNotMatch(verifierCall, /fullFrameBuffer\.toString\('base64'\)/);
assert.doesNotMatch(verifierCall, /\.\.\.candidates\.map/);
assert.match(verifierCall, /for \([\s\S]*candidateIndex < candidates\.length/);

assert.match(verifier, /filter\(\(group\) => hasYoloSupport\(group\.detection\)\)/);
assert.match(verifier, /grounding_dino_open_vocabulary_candidate_unverified/);
assert.match(verifier, /object_detection_confidence_below_display_threshold/);
assert.match(verifier, /trackTtlMs/);
assert.doesNotMatch(verifier, /unverified person candidate/);

assert.match(yolo, /detectionMinIntervalMs:/);
assert.match(yaml, /detection_min_interval_ms:\s*500/);
assert.match(yaml, /person_verifier_crop_max_dimension:\s*512/);
assert.match(yaml, /person_verifier_max_dino_only_candidates:\s*0/);
assert.match(yaml, /person_verifier_track_ttl_ms:\s*3000/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_LIVE_FRAME_CROP_ONLY_VERIFIER_CONTRACT_PASS',
  detector_reads_current_live_frame_buffer: true,
  detector_schedule_is_time_based: true,
  scene_vlm_does_not_gate_detector: true,
  verifier_network_payload_is_crop_only: true,
  full_frame_sent_to_person_verifier: false,
  dino_only_person_candidates_displayed: false,
  raw_person_fallbacks_added: false,
  live_services_started: false
}, null, 2));
