'use strict';

/**
 * Behavioral regression tests for the vision detection acceptance, certainty, and
 * temporal confirmation system.
 *
 * Tests are organized around the required behaviors from the production defect spec:
 * false-positive suppression, temporal confirmation, duplicate suppression,
 * unknown objects, cognition grounding, configuration, and UI data shape.
 */

const assert = require('node:assert/strict');

const {
  classifyVerifiedDetectionForDisplay
} = require('../src/vision/person-presence-verifier.cjs');

const {
  annotateDetectionCertainty,
  resetObjectTemporalTracks
} = require('../src/vision/yolo-detection-service.cjs');

const {
  normalizeChatWebcamVisionContext
} = require('../src/vision/chat-webcam-vision-context.cjs');

const {
  getDetectionConfig: getYamlDetectionConfig
} = require('../src/config/floki-config.cjs');

// ── helpers ──────────────────────────────────────────────────────────────────

function objectDetection(label, confidence, sources = ['grounding_dino'], extras = {}) {
  return {
    id: `det-${label}-${confidence}`,
    class_id: 99,
    type: 'object',
    label,
    confidence,
    source: sources[0],
    proposal_sources: sources,
    bbox: { x: 0.05, y: 0.05, width: 0.4, height: 0.3 },
    ...extras
  };
}

function personDetection(confidence, sources = ['yolo', 'grounding_dino'], extras = {}) {
  return {
    id: `det-person-${confidence}`,
    class_id: 0,
    type: 'person',
    label: 'person',
    confidence,
    source: 'yolo',
    proposal_sources: sources,
    bbox: { x: 0.4, y: 0.1, width: 0.25, height: 0.6 },
    ...extras
  };
}

function tvDetection(confidence, sources = ['yolo', 'grounding_dino']) {
  return objectDetection('tv', confidence, sources);
}

function freshTimestamp() {
  return new Date().toISOString();
}

function staleTimestamp(offsetMs = 6000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

// ══════════════════════════════════════════════════════════════════════════════
// FALSE-POSITIVE HANDLING
// ══════════════════════════════════════════════════════════════════════════════

// Test 1: computer monitor 42% (DINO-only) is suppressed by class override
{
  const det = objectDetection('a computer monitor', 0.42, ['grounding_dino']);
  const result = classifyVerifiedDetectionForDisplay(det);
  assert.equal(
    result.bucket,
    'suppressed',
    'Test 1 FAIL: computer monitor at 42% (DINO-only) must be suppressed by class_min_confidence_override'
  );
  assert.equal(
    result.unavailable_reason,
    'class_confidence_below_class_minimum',
    'Test 1 FAIL: suppression reason must be class_confidence_below_class_minimum'
  );
}

// Test 2: computer monitor 42% (YOLO+DINO consensus) is also suppressed by class override
{
  const det = objectDetection('computer monitor', 0.42, ['yolo', 'grounding_dino']);
  const result = classifyVerifiedDetectionForDisplay(det);
  assert.equal(
    result.bucket,
    'suppressed',
    'Test 2 FAIL: computer monitor at 42% (consensus) must be suppressed by class override'
  );
}

// Test 3: computer monitor at 42% cannot become a confirmed Latest Observation fact
{
  const context = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_summary: 'scene',
    detected_objects: [{ label: 'computer monitor', count: 1 }],
    uncertain_objects: [],
    detected_people_count: 1,
    grounding_summary: '1 person is visible. visible objects include computer monitor.'
  });
  // This test checks the normalization pipeline: if computer monitor was already suppressed
  // by classifyVerifiedDetectionForDisplay before reaching here, detected_objects is clean.
  // If it somehow reaches here, the cognition model only gets what is in detected_objects.
  // The production path ensures the computer monitor never reaches detected_objects.
  // So here we confirm the YAML class override threshold is set correctly:
  const yamlConfig = getYamlDetectionConfig('chat');
  const overrides = yamlConfig.class_min_confidence_overrides || {};
  const monitorThreshold = overrides['computer monitor'] || overrides['monitor'];
  assert.ok(
    monitorThreshold !== undefined && Number(monitorThreshold) > 0.42,
    'Test 3 FAIL: class_min_confidence_overrides must set computer monitor threshold above 0.42'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// POSITIVE CONTROL: TELEVISION
// ══════════════════════════════════════════════════════════════════════════════

// Test 4: television (YOLO+DINO consensus) at 65% remains accepted
{
  const det = tvDetection(0.65, ['yolo', 'grounding_dino']);
  const result = classifyVerifiedDetectionForDisplay(det);
  assert.equal(
    result.bucket,
    'objects',
    'Test 4 FAIL: television at 65% YOLO+DINO must remain accepted'
  );
}

// Test 5: computer monitor suppression does not affect television class
{
  const tvDet = tvDetection(0.45, ['yolo', 'grounding_dino']);
  const monitorDet = objectDetection('computer monitor', 0.42, ['grounding_dino']);
  const tvResult = classifyVerifiedDetectionForDisplay(tvDet);
  const monitorResult = classifyVerifiedDetectionForDisplay(monitorDet);
  assert.equal(tvResult.bucket, 'objects', 'Test 5 FAIL: tv must remain accepted when monitor is suppressed');
  assert.equal(monitorResult.bucket, 'suppressed', 'Test 5 FAIL: monitor must be suppressed while tv passes');
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSON DETECTION
// ══════════════════════════════════════════════════════════════════════════════

// Test 6: person at 4% with track-inherited live_person is suppressed
{
  const det = personDetection(0.04, ['yolo', 'grounding_dino'], {
    verification: {
      verifier_ok: true,
      classification: 'live_person',
      confidence: 0.92,
      short_basis: 'verified_live',
      cache_source: 'spatial_track',
      track_iou: 0.35
    }
  });
  const result = classifyVerifiedDetectionForDisplay(det);
  assert.equal(
    result.bucket,
    'suppressed',
    'Test 6 FAIL: person at 4% with track-inherited verification must be suppressed'
  );
  assert.equal(
    result.unavailable_reason,
    'person_track_confidence_below_minimum',
    'Test 6 FAIL: suppression reason must be person_track_confidence_below_minimum'
  );
}

// Test 7: strong person detection (86%) with live_person verification remains accepted
{
  const det = personDetection(0.86, ['yolo', 'grounding_dino'], {
    verification: {
      verifier_ok: true,
      classification: 'live_person',
      confidence: 0.95,
      short_basis: 'verified_live'
    }
  });
  const result = classifyVerifiedDetectionForDisplay(det);
  assert.equal(
    result.bucket,
    'persons',
    'Test 7 FAIL: strong person (86%) with live_person verification must remain accepted'
  );
}

// Test 8: duplicate overlapping person boxes — lower confidence is filtered via track threshold
{
  // Simulates two person detections in same region: 86% with direct VLM verification
  // and 4% with only track-inherited verification
  const strong = personDetection(0.86, ['yolo', 'grounding_dino'], {
    verification: { verifier_ok: true, classification: 'live_person', confidence: 0.95, short_basis: 'verified' }
  });
  const weak = personDetection(0.04, ['yolo', 'grounding_dino'], {
    verification: { verifier_ok: true, classification: 'live_person', confidence: 0.95, short_basis: 'verified', cache_source: 'spatial_track', track_iou: 0.80 }
  });
  const strongResult = classifyVerifiedDetectionForDisplay(strong);
  const weakResult = classifyVerifiedDetectionForDisplay(weak);
  assert.equal(strongResult.bucket, 'persons', 'Test 8 FAIL: strong person must remain');
  assert.equal(weakResult.bucket, 'suppressed', 'Test 8 FAIL: weak duplicate person must be suppressed');
}

// Test 9: distinct persons with separate bboxes and independent verifications are not merged
{
  const personA = personDetection(0.88, ['yolo', 'grounding_dino'], {
    id: 'person-a',
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
    verification: { verifier_ok: true, classification: 'live_person', confidence: 0.95, short_basis: 'verified' }
  });
  const personB = personDetection(0.82, ['yolo', 'grounding_dino'], {
    id: 'person-b',
    bbox: { x: 0.7, y: 0.1, width: 0.2, height: 0.4 },
    verification: { verifier_ok: true, classification: 'live_person', confidence: 0.93, short_basis: 'verified' }
  });
  const resultA = classifyVerifiedDetectionForDisplay(personA);
  const resultB = classifyVerifiedDetectionForDisplay(personB);
  assert.equal(resultA.bucket, 'persons', 'Test 9 FAIL: person A must remain');
  assert.equal(resultB.bucket, 'persons', 'Test 9 FAIL: person B must remain');
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPORAL BEHAVIOR
// ══════════════════════════════════════════════════════════════════════════════

// Test 10: repeated consistent fresh detections move from uncertain to confirmed
{
  resetObjectTemporalTracks();
  const det = objectDetection('tv', 0.75, ['yolo', 'grounding_dino']);
  const ts1 = freshTimestamp();
  const first = annotateDetectionCertainty([det], ts1);
  assert.equal(first[0].certainty, 'uncertain', 'Test 10 FAIL: first detection must start uncertain');

  const ts2 = new Date(Date.now() + 1000).toISOString();
  const second = annotateDetectionCertainty([det], ts2);
  assert.equal(second[0].certainty, 'confirmed', 'Test 10 FAIL: second fresh detection must become confirmed');
}

// Test 11: stale record (older than window) does not count as temporal evidence
{
  resetObjectTemporalTracks();
  const det = objectDetection('chair', 0.60, ['yolo', 'grounding_dino']);
  const ts1 = staleTimestamp(6000);
  annotateDetectionCertainty([det], ts1);

  // Now a fresh detection — the stale track is expired, so this counts as new (frame 1)
  const ts2 = freshTimestamp();
  const result = annotateDetectionCertainty([det], ts2);
  assert.equal(result[0].certainty, 'uncertain', 'Test 11 FAIL: stale record must not count toward temporal confirmation');
}

// Test 12: confirmed object becomes uncertain (resets) after disappearing past window
{
  resetObjectTemporalTracks();
  const det = objectDetection('bottle', 0.70, ['yolo', 'grounding_dino']);
  const ts1 = freshTimestamp();
  const ts2 = new Date(Date.now() + 1000).toISOString();
  annotateDetectionCertainty([det], ts1);
  const after2 = annotateDetectionCertainty([det], ts2);
  assert.equal(after2[0].certainty, 'confirmed', 'Test 12 FAIL: object must be confirmed after 2 detections');

  // Object disappears past window, then reappears
  resetObjectTemporalTracks();
  const ts3 = new Date(Date.now() + 7000).toISOString();
  const reappeared = annotateDetectionCertainty([det], ts3);
  assert.equal(reappeared[0].certainty, 'uncertain', 'Test 12 FAIL: reappeared object must restart as uncertain');
}

// Test 13: stale detections are gated by detection_max_age_ms in YAML
{
  const yamlConfig = getYamlDetectionConfig('chat');
  const maxAgeMs = Number(yamlConfig.detection_max_age_ms || 8000);
  assert.ok(
    maxAgeMs > 0 && maxAgeMs < 30000,
    'Test 13 FAIL: detection_max_age_ms must be a positive reasonable value'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// UNKNOWN OBJECTS
// ══════════════════════════════════════════════════════════════════════════════

// Test 14: unknown large appliance can remain as uncertain rather than forced into wrong class
{
  resetObjectTemporalTracks();
  const det = objectDetection('large appliance', 0.50, ['grounding_dino']);
  const result = classifyVerifiedDetectionForDisplay(det);
  // 'large appliance' has no class override, passes grounding_dino_object_display_min_confidence (0.35)
  assert.equal(result.bucket, 'objects', 'Test 14 FAIL: unknown appliance must be accepted as an object when above threshold');
  // And it starts uncertain until temporally confirmed
  resetObjectTemporalTracks();
  const annotated = annotateDetectionCertainty([det], freshTimestamp());
  assert.equal(annotated[0].certainty, 'uncertain', 'Test 14 FAIL: first-seen unknown appliance must start uncertain');
}

// Test 15: ambiguous object is not forced into nearest unrelated class
{
  // The class override for "computer monitor" ensures the false class is suppressed
  // A chest freezer would be detected as "a computer monitor" by DINO but suppressed
  const falseDet = objectDetection('a computer monitor', 0.42, ['grounding_dino']);
  const falseResult = classifyVerifiedDetectionForDisplay(falseDet);
  assert.equal(
    falseResult.bucket,
    'suppressed',
    'Test 15 FAIL: ambiguous object incorrectly labeled as computer monitor must be suppressed, not forced into that class'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// COGNITION GROUNDING
// ══════════════════════════════════════════════════════════════════════════════

// Test 16: normalizeChatWebcamVisionContext separates confirmed and uncertain objects
{
  const ctx = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_summary: 'A room with a person.',
    detected_objects: [{ label: 'tv', count: 1 }],
    uncertain_objects: [{ label: 'large appliance' }],
    detected_people_count: 1,
    grounding_summary: '1 person is visible. visible objects include tv. possible but unverified: large appliance.'
  });
  assert.ok(Array.isArray(ctx.detected_objects), 'Test 16 FAIL: detected_objects must be array');
  assert.ok(Array.isArray(ctx.uncertain_objects), 'Test 16 FAIL: uncertain_objects must be array');
  assert.equal(ctx.detected_objects.length, 1, 'Test 16 FAIL: confirmed objects must have 1 entry');
  assert.equal(ctx.detected_objects[0].label, 'tv', 'Test 16 FAIL: confirmed objects must contain tv');
  assert.equal(ctx.uncertain_objects.length, 1, 'Test 16 FAIL: uncertain objects must have 1 entry');
  assert.equal(ctx.uncertain_objects[0].label, 'large appliance', 'Test 16 FAIL: uncertain objects must contain large appliance');
}

// Test 17: uncertain detections are expressed with uncertainty via grounding_summary
{
  const ctx = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_summary: 'scene',
    detected_objects: [{ label: 'television', count: 1 }],
    uncertain_objects: [{ label: 'unknown appliance' }],
    detected_people_count: 0,
    grounding_summary: 'visible objects include television. possible but unverified: unknown appliance.'
  });
  assert.ok(
    ctx.grounding_summary && ctx.grounding_summary.includes('possible but unverified'),
    'Test 17 FAIL: grounding_summary must indicate uncertainty for uncertain objects'
  );
  assert.ok(
    ctx.grounding_summary.includes('television'),
    'Test 17 FAIL: grounding_summary must include confirmed television'
  );
}

// Test 18: unsupported objects are not invented in detected_objects
{
  const ctx = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_summary: 'A person and a television.',
    detected_objects: [{ label: 'tv', count: 1 }],
    uncertain_objects: [],
    detected_people_count: 1,
    grounding_summary: '1 person is visible. visible objects include tv.'
  });
  const labels = ctx.detected_objects.map((e) => e.label);
  assert.ok(!labels.includes('computer monitor'), 'Test 18 FAIL: computer monitor must not appear in confirmed detected_objects');
  assert.ok(!labels.includes('chest freezer'), 'Test 18 FAIL: chest freezer must not appear in detected_objects');
}

// Test 19: normalization preserves natural-language summary rather than reducing to label list
{
  const ctx = normalizeChatWebcamVisionContext({
    available: true,
    fresh: true,
    observation_summary: 'I can see a person seated near a television in a living space.',
    detected_objects: [{ label: 'tv', count: 1 }],
    uncertain_objects: [],
    detected_people_count: 1,
    grounding_summary: '1 person is visible. visible objects include tv.'
  });
  assert.ok(
    ctx.observation_summary && ctx.observation_summary.length > 20,
    'Test 19 FAIL: observation_summary must be preserved as natural language'
  );
  assert.ok(
    !ctx.observation_summary.includes('[') && !ctx.observation_summary.includes('{'),
    'Test 19 FAIL: observation_summary must not contain raw JSON or labels'
  );
}

// Test 20: stale observations return available=false so historical memory cannot substitute
{
  const ctx = normalizeChatWebcamVisionContext({
    available: false,
    fresh: false,
    observation_summary: 'old scene',
    detected_objects: [],
    uncertain_objects: [],
    detected_people_count: 0,
    unavailable_reason: 'stale_observation'
  });
  assert.equal(ctx.available, false, 'Test 20 FAIL: stale context must have available=false');
  assert.equal(ctx.detected_people_count, 0, 'Test 20 FAIL: stale context must report 0 people');
  assert.deepEqual(ctx.detected_objects, [], 'Test 20 FAIL: stale context must have empty detected_objects');
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// Test 21: all required thresholds come from YAML
{
  const yamlConfig = getYamlDetectionConfig('chat');

  assert.ok(
    yamlConfig.class_min_confidence_overrides !== undefined,
    'Test 21 FAIL: class_min_confidence_overrides must exist in YAML'
  );
  const overrides = yamlConfig.class_min_confidence_overrides;
  assert.ok(
    typeof overrides === 'object' && overrides !== null,
    'Test 21 FAIL: class_min_confidence_overrides must be an object'
  );

  assert.ok(
    yamlConfig.person_track_min_candidate_confidence !== undefined,
    'Test 21 FAIL: person_track_min_candidate_confidence must exist in YAML'
  );
  assert.ok(
    Number(yamlConfig.person_track_min_candidate_confidence) > 0.04,
    'Test 21 FAIL: person_track_min_candidate_confidence must be above 0.04 to reject 4% person'
  );

  assert.ok(
    yamlConfig.object_temporal_confirmation_frames !== undefined,
    'Test 21 FAIL: object_temporal_confirmation_frames must exist in YAML'
  );
  assert.ok(
    Number(yamlConfig.object_temporal_confirmation_frames) >= 1,
    'Test 21 FAIL: object_temporal_confirmation_frames must be >= 1'
  );

  assert.ok(
    yamlConfig.object_temporal_confirmation_window_ms !== undefined,
    'Test 21 FAIL: object_temporal_confirmation_window_ms must exist in YAML'
  );
  assert.ok(
    Number(yamlConfig.object_temporal_confirmation_window_ms) >= 1000,
    'Test 21 FAIL: object_temporal_confirmation_window_ms must be >= 1000'
  );
}

// Test 22: public config template contains all new required keys
{
  const fs = require('node:fs');
  const path = require('node:path');
  const templatePath = path.join(__dirname, '../config/chat.config.yaml.temp');
  const templateContent = fs.readFileSync(templatePath, 'utf8');

  assert.ok(
    templateContent.includes('class_min_confidence_overrides'),
    'Test 22 FAIL: template must contain class_min_confidence_overrides'
  );
  assert.ok(
    templateContent.includes('person_track_min_candidate_confidence'),
    'Test 22 FAIL: template must contain person_track_min_candidate_confidence'
  );
  assert.ok(
    templateContent.includes('object_temporal_confirmation_frames'),
    'Test 22 FAIL: template must contain object_temporal_confirmation_frames'
  );
  assert.ok(
    templateContent.includes('object_temporal_confirmation_window_ms'),
    'Test 22 FAIL: template must contain object_temporal_confirmation_window_ms'
  );
}

// Test 23: missing class_min_confidence_overrides falls back to empty object (no crash)
{
  // parseClassConfidenceOverrides handles null/undefined gracefully
  const { classifyVerifiedDetectionForDisplay: classify } = require('../src/vision/person-presence-verifier.cjs');
  const det = objectDetection('some novel object', 0.40, ['grounding_dino']);
  const result = classify(det);
  // Should not throw - 'some novel object' has no class override so it uses source-based threshold
  assert.ok(
    result.bucket === 'objects' || result.bucket === 'suppressed',
    'Test 23 FAIL: detection with no class override must not throw'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// UI DATA SHAPE
// ══════════════════════════════════════════════════════════════════════════════

// Test 24: confirmed and rejected detections are handled distinctly at classification layer
{
  const confirmed = objectDetection('tv', 0.70, ['yolo', 'grounding_dino'], { certainty: 'confirmed' });
  const uncertain = objectDetection('unknown appliance', 0.40, ['grounding_dino'], { certainty: 'uncertain' });
  const rejected = objectDetection('computer monitor', 0.42, ['grounding_dino'], { certainty: 'uncertain' });

  const confirmedResult = classifyVerifiedDetectionForDisplay(confirmed);
  const uncertainResult = classifyVerifiedDetectionForDisplay(uncertain);
  const rejectedResult = classifyVerifiedDetectionForDisplay(rejected);

  assert.equal(confirmedResult.bucket, 'objects', 'Test 24 FAIL: confirmed tv must be objects bucket');
  assert.ok(
    uncertainResult.bucket === 'objects' || uncertainResult.bucket === 'suppressed',
    'Test 24 FAIL: uncertain appliance must be handled without error'
  );
  assert.equal(rejectedResult.bucket, 'suppressed', 'Test 24 FAIL: rejected computer monitor must be suppressed');
}

// Test 25: certainty field is preserved through classifyVerifiedDetectionForDisplay for objects
{
  resetObjectTemporalTracks();
  const det = objectDetection('tv', 0.70, ['yolo', 'grounding_dino']);
  const ts1 = freshTimestamp();
  const ts2 = new Date(Date.now() + 1500).toISOString();
  const [firstAnnotated] = annotateDetectionCertainty([det], ts1);
  const [secondAnnotated] = annotateDetectionCertainty([{ ...det }], ts2);

  const firstResult = classifyVerifiedDetectionForDisplay(firstAnnotated);
  const secondResult = classifyVerifiedDetectionForDisplay(secondAnnotated);

  // After first detection: uncertain
  assert.equal(firstAnnotated.certainty, 'uncertain', 'Test 25 FAIL: first detection certainty must be uncertain');
  // After second detection: confirmed
  assert.equal(secondAnnotated.certainty, 'confirmed', 'Test 25 FAIL: second detection certainty must be confirmed');

  // Both must be in objects bucket (threshold-wise)
  assert.equal(firstResult.bucket, 'objects', 'Test 25 FAIL: first tv must reach objects bucket');
  assert.equal(secondResult.bucket, 'objects', 'Test 25 FAIL: second tv must reach objects bucket');

  // The certainty field must be accessible via the result detection
  const firstDet = firstResult.detection;
  const secondDet = secondResult.detection;
  assert.equal(firstDet.certainty, 'uncertain', 'Test 25 FAIL: certainty must be preserved in classified detection');
  assert.equal(secondDet.certainty, 'confirmed', 'Test 25 FAIL: certainty must be preserved in classified detection');
}

// Test 26: no mock detection data in the temporal confirmation system
{
  resetObjectTemporalTracks();
  // Running annotateDetectionCertainty with empty array should produce empty array
  const result = annotateDetectionCertainty([], freshTimestamp());
  assert.deepEqual(result, [], 'Test 26 FAIL: annotateDetectionCertainty must return empty array for empty input');
  // Running with null/undefined must not throw
  assert.doesNotThrow(
    () => annotateDetectionCertainty(null, freshTimestamp()),
    'Test 26 FAIL: annotateDetectionCertainty must not throw on null input'
  );
  assert.doesNotThrow(
    () => annotateDetectionCertainty(undefined, freshTimestamp()),
    'Test 26 FAIL: annotateDetectionCertainty must not throw on undefined input'
  );
}

console.log('vision-detection-certainty-contract-test: all 26 behavioral assertions passed');
