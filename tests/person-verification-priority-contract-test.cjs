'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const service = fs.readFileSync(
  path.join(
    root,
    'src/vision/chat-webcam-vision-service.cjs'
  ),
  'utf8'
);

const verifier = fs.readFileSync(
  path.join(
    root,
    'src/vision/person-presence-verifier.cjs'
  ),
  'utf8'
);

const dinoWorker = fs.readFileSync(
  path.join(
    root,
    '.floki-tools/grounding-dino/grounding-dino-worker.py'
  ),
  'utf8'
);

assert.match(
  service,
  /sceneInferenceUnlocked\s*=\s*getDetectionConfig\(\)\.enabled\s*!==\s*true/
);

assert.match(
  service,
  /!sceneInferenceUnlocked\s*\|\|/
);

assert.match(
  service,
  /inferenceAbortController\.abort\(\)/
);

assert.match(
  service,
  /attachCachedPersonVerifications\(\s*current\.detection\s*\)/
);

assert.doesNotMatch(
  service,
  /current\.detection\.frame_id\s*===\s*verifiedFrame\.frame_id/
);

assert.match(
  service,
  /isAbortError\(\s*error,\s*inferenceAbortController/
);

assert.match(
  verifier,
  /grounding_dino_open_vocabulary_candidate_unverified/
);

assert.match(
  verifier,
  /cache_source:\s*'spatial_track'/
);

assert.match(
  verifier,
  /person_verifier_min_dino_only_area/
);

assert.doesNotMatch(
  verifier,
  /unverified person candidate/
);

assert.match(
  dinoWorker,
  /depiction_terms\s*=\s*\(/
);

assert.match(
  dinoWorker,
  /if any\(term in value for term in depiction_terms\):\s*\n\s*return False/
);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_PERSON_VERIFICATION_PRIORITY_CONTRACT_PASS',
  first_scene_waits_for_person_verification: true,
  person_verification_can_preempt_scene: true,
  aborted_scene_not_counted_as_failure: true,
  verified_result_applied_to_current_boxes: true,
  exact_frame_id_discard_removed: true,
  dino_only_open_vocabulary_boxes_suppressed: true,
  live_services_started: false
}, null, 2));
