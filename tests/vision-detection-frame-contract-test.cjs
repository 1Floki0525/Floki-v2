'use strict';

const assert = require('node:assert/strict');

const {
  createInitialDetectionFrameState,
  reduceDetectionFrameState,
  suppressDuplicateDetections,
  splitDisplayDetections
} = require('../src/vision/detection-frame-contract.cjs');
const { getDetectionConfig } = require('../src/config/floki-config.cjs');
const {
  annotateDetectionCertainty,
  parseYoloDetectionFrame,
  resetObjectTemporalTracks
} = require('../src/vision/yolo-detection-service.cjs');
const {
  objectClassForDetection,
  objectPolicyDisposition
} = require('../src/vision/object-class-policy.cjs');

function detection(id, label, confidence, bbox, extra = {}) {
  return {
    id,
    class_id: label === 'person' ? 0 : 1,
    type: label === 'person' ? 'person' : 'object',
    label,
    confidence,
    bbox,
    source: 'yolo',
    proposal_sources: ['yolo'],
    ...extra
  };
}

function frame(sequence, detections, extra = {}) {
  const capturedAtMs = extra.captured_at_ms ?? 1000 + sequence * 100;
  return {
    ok: true,
    schema_version: 1,
    stream_session_id: extra.stream_session_id || 'session-a',
    frame_id: extra.frame_id || `frame-${sequence}`,
    frame_sequence: sequence,
    result_sequence: sequence,
    captured_at: new Date(capturedAtMs).toISOString(),
    captured_at_ms: capturedAtMs,
    detected_at: new Date(capturedAtMs + 10).toISOString(),
    detected_at_ms: capturedAtMs + 10,
    image_width: 1280,
    image_height: 720,
    device: 'test',
    model_source: 'test',
    detections,
    stale: false,
    age_ms: 0,
    ...extra
  };
}

const config = getDetectionConfig('chat');
assert.equal(typeof config.detection_result_max_age_ms, 'number');
assert.equal(typeof config.detection_nms_iou_threshold, 'number');
assert.equal(typeof config.detection_max_boxes_per_frame, 'number');
assert.equal(typeof config.detection_max_boxes_per_class, 'number');
assert.equal(config.detection_out_of_order_drop_enabled, true);
assert.equal(typeof config.object_class_policy, 'object');
assert.equal(config.object_class_policy.classes.television.confirmation_frames, 3);

let state = createInitialDetectionFrameState({ session_id: 'session-a' });
const first = reduceDetectionFrameState(state, frame(1, [
  detection('person-old', 'person', 0.91, { x: 0.1, y: 0.1, width: 0.2, height: 0.5 })
]), { now_ms: 1200, max_age_ms: 5000 });
assert.equal(first.accepted, true);
assert.equal(first.state.detections.length, 1);

const second = reduceDetectionFrameState(first.state, frame(2, [
  detection('chair-new', 'chair', 0.88, { x: 0.6, y: 0.4, width: 0.2, height: 0.3 })
]), { now_ms: 1300, max_age_ms: 5000 });
assert.equal(second.accepted, true);
assert.deepEqual(second.state.detections.map((entry) => entry.id), ['chair-new']);
assert.equal(second.state.detections.some((entry) => entry.id === 'person-old'), false);

const outOfOrder = reduceDetectionFrameState(second.state, frame(1, [
  detection('person-old-returned', 'person', 0.99, { x: 0.1, y: 0.1, width: 0.2, height: 0.5 })
]), { now_ms: 1400, max_age_ms: 5000 });
assert.equal(outOfOrder.accepted, false);
assert.equal(outOfOrder.reason, 'out_of_order');
assert.deepEqual(outOfOrder.state.detections.map((entry) => entry.id), ['chair-new']);

const duplicateEvent = reduceDetectionFrameState(second.state, frame(2, [
  detection('chair-new-copy', 'chair', 0.87, { x: 0.6, y: 0.4, width: 0.2, height: 0.3 })
]), { now_ms: 1450, max_age_ms: 5000 });
assert.equal(duplicateEvent.accepted, false);
assert.equal(duplicateEvent.reason, 'duplicate_sequence');

const oldSession = reduceDetectionFrameState(second.state, frame(3, [
  detection('other-session-person', 'person', 0.99, { x: 0.1, y: 0.1, width: 0.2, height: 0.5 })
], { stream_session_id: 'session-b' }), { now_ms: 1500, max_age_ms: 5000 });
assert.equal(oldSession.accepted, false);
assert.equal(oldSession.reason, 'session_mismatch');

const stale = reduceDetectionFrameState(second.state, frame(4, [
  detection('stale-chair', 'chair', 0.99, { x: 0.6, y: 0.4, width: 0.2, height: 0.3 })
], { captured_at_ms: 1000, detected_at_ms: 1010 }), { now_ms: 9000, max_age_ms: 5000 });
assert.equal(stale.accepted, false);
assert.equal(stale.reason, 'stale_result');
assert.equal(stale.state.detections.length, 0);

state = createInitialDetectionFrameState({ session_id: 'session-a' });
const empty = reduceDetectionFrameState(state, frame(5, []), { now_ms: 1600, max_age_ms: 5000 });
assert.equal(empty.accepted, true);
assert.equal(empty.state.detections.length, 0);

const suppressed = suppressDuplicateDetections([
  detection('person-low', 'person', 0.74, { x: 0.1, y: 0.1, width: 0.3, height: 0.6 }),
  detection('person-high', 'person', 0.91, { x: 0.11, y: 0.11, width: 0.3, height: 0.6 }),
  detection('person-separate', 'person', 0.87, { x: 0.62, y: 0.1, width: 0.22, height: 0.55 }),
  detection('face-inside-person', 'face', 0.96, { x: 0.18, y: 0.12, width: 0.08, height: 0.1 }, { class_id: 100, type: 'face' }),
  detection('nan-box', 'chair', 0.99, { x: NaN, y: 0.2, width: 0.2, height: 0.2 })
], {
  iou_threshold: 0.5,
  max_boxes_per_frame: 10,
  max_boxes_per_class: 5
});
assert.deepEqual(
  suppressed.detections.map((entry) => entry.id).sort(),
  ['face-inside-person', 'person-high', 'person-separate'].sort()
);
assert.equal(suppressed.dropped.invalid, 1);
assert.equal(suppressed.dropped.duplicates, 1);

const capped = suppressDuplicateDetections([
  detection('chair-1', 'chair', 0.99, { x: 0.01, y: 0.1, width: 0.05, height: 0.1 }),
  detection('chair-2', 'chair', 0.98, { x: 0.10, y: 0.1, width: 0.05, height: 0.1 }),
  detection('chair-3', 'chair', 0.97, { x: 0.20, y: 0.1, width: 0.05, height: 0.1 })
], {
  iou_threshold: 0.5,
  max_boxes_per_frame: 10,
  max_boxes_per_class: 2
});
assert.deepEqual(capped.detections.map((entry) => entry.id), ['chair-1', 'chair-2']);
assert.equal(capped.dropped.max_per_class, 1);

const display = splitDisplayDetections(frame(6, [
  detection('scene-chair', 'chair', 0.9, { x: 0.5, y: 0.3, width: 0.1, height: 0.1 }),
  { id: 'scene-only', type: 'scene', label: 'television', confidence: 0.9 }
]), { now_ms: 1700, max_age_ms: 5000 });
assert.equal(display.objects.length, 1);
assert.equal(display.persons.length, 0);
assert.equal(display.objects[0].id, 'scene-chair');

resetObjectTemporalTracks();
const tvPolicy = objectClassForDetection(detection(
  'tv-candidate',
  'a television screen',
  0.36,
  { x: 0.78, y: 0.02, width: 0.18, height: 0.9 },
  { source: 'grounding_dino', proposal_sources: ['grounding_dino'] }
));
assert.equal(tvPolicy.canonical, 'television');
assert.equal(tvPolicy.policy.confirmationFrames, 3);
const doorwayPolicy = objectClassForDetection(detection(
  'doorway-candidate',
  'a doorway',
  0.41,
  { x: 0.18, y: 0.12, width: 0.15, height: 0.52 },
  { source: 'grounding_dino', proposal_sources: ['grounding_dino'] }
));
assert.equal(doorwayPolicy.canonical, 'doorway');
assert.equal(doorwayPolicy.policy.confirmationFrames, 2);

const firstTv = annotateDetectionCertainty([
  detection('real-tv-1', 'a television screen', 0.36, { x: 0.78, y: 0.02, width: 0.18, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 10_000);
assert.equal(firstTv[0].certainty, 'uncertain');
assert.equal(splitDisplayDetections(frame(20, firstTv), { now_ms: 3100, max_age_ms: 5000 }).objects.length, 0, 'one-frame ambiguous object candidate must not render');

const secondTv = annotateDetectionCertainty([
  detection('real-tv-2', 'a television screen', 0.37, { x: 0.781, y: 0.021, width: 0.181, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 12_000);
assert.equal(secondTv[0].certainty, 'uncertain');

const thirdTv = annotateDetectionCertainty([
  detection('real-tv-3', 'a television screen', 0.38, { x: 0.779, y: 0.019, width: 0.18, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 14_000);
assert.equal(thirdTv[0].certainty, 'confirmed');
assert.equal(splitDisplayDetections(frame(21, thirdTv), { now_ms: 3200, max_age_ms: 5000 }).objects.length, 1, 'spatially stable ambiguous object becomes confirmed');

const retainedTv = annotateDetectionCertainty([], 15_000);
assert.equal(retainedTv.length, 1);
assert.equal(retainedTv[0].retained_track, true);
assert.equal(splitDisplayDetections(frame(22, retainedTv), { now_ms: 3300, max_age_ms: 5000 }).objects.length, 1, 'confirmed object survives configured short miss window');
const maintainedLowTv = annotateDetectionCertainty([
  detection('real-tv-maintained', 'a television screen', 0.32, { x: 0.78, y: 0.02, width: 0.18, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 16_000);
assert.equal(maintainedLowTv[0].certainty, 'confirmed', 'confirmed objects use YAML maintain confidence instead of initial confidence');
assert.equal(splitDisplayDetections(frame(25, maintainedLowTv), { now_ms: 3350, max_age_ms: 5000 }).objects.length, 1, 'maintained confirmed object remains displayable in maintain threshold band');
const expiredTv = annotateDetectionCertainty([], 20_000);
assert.equal(expiredTv.length, 0, 'confirmed object expires after configured miss TTL/window');

resetObjectTemporalTracks();
annotateDetectionCertainty([
  detection('real-tv-a', 'a television screen', 0.36, { x: 0.78, y: 0.02, width: 0.18, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 20_000);
annotateDetectionCertainty([
  detection('real-tv-b', 'a television screen', 0.37, { x: 0.781, y: 0.021, width: 0.181, height: 0.9 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 22_000);
const separateDoorway = annotateDetectionCertainty([
  detection('separate-same-label', 'a television screen', 0.44, { x: 0.18, y: 0.12, width: 0.15, height: 0.52 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 24_000);
assert.equal(separateDoorway[0].certainty, 'uncertain', 'spatially separate same-class candidate must not inherit confirmation');
assert.equal(splitDisplayDetections(frame(23, separateDoorway), { now_ms: 3400, max_age_ms: 5000 }).objects.length, 0, 'doorway-like false candidate stays hidden until spatially confirmed');

const lowMonitor = detection('low-monitor', 'a computer monitor', 0.42, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, {
  source: 'grounding_dino',
  proposal_sources: ['grounding_dino'],
  certainty: 'confirmed'
});
assert.equal(objectPolicyDisposition(lowMonitor).allowed, false, 'per-class YAML policy suppresses low-confidence monitor');

resetObjectTemporalTracks();
const doorwayOne = annotateDetectionCertainty([
  detection('doorway-1', 'a doorway', 0.41, { x: 0.18, y: 0.12, width: 0.15, height: 0.52 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 30_000);
assert.equal(doorwayOne[0].certainty, 'uncertain');
const doorwayTwo = annotateDetectionCertainty([
  detection('doorway-2', 'a doorway', 0.42, { x: 0.181, y: 0.121, width: 0.15, height: 0.52 }, {
    source: 'grounding_dino',
    proposal_sources: ['grounding_dino']
  })
], 32_000);
assert.equal(doorwayTwo[0].certainty, 'confirmed');
const doorwayDisplay = splitDisplayDetections(frame(24, doorwayTwo), { now_ms: 3500, max_age_ms: 5000 });
assert.equal(doorwayDisplay.objects.length, 1);
assert.equal(doorwayDisplay.objects[0].object_track_class, 'doorway');

resetObjectTemporalTracks();
const tvA1 = detection('tv-a-1', 'a television screen', 0.80, { x: 0.05, y: 0.1, width: 0.08, height: 0.2 });
const tvB1 = detection('tv-b-1', 'a television screen', 0.78, { x: 0.25, y: 0.1, width: 0.08, height: 0.2 });
const tvA2 = detection('tv-a-2', 'a television screen', 0.81, { x: 0.051, y: 0.1, width: 0.08, height: 0.2 });
const tvB2 = detection('tv-b-2', 'a television screen', 0.79, { x: 0.251, y: 0.1, width: 0.08, height: 0.2 });
annotateDetectionCertainty([tvA1, tvB1], 40_000);
annotateDetectionCertainty([tvA2, tvB2], 42_000);
annotateDetectionCertainty([
  detection('tv-b-3', 'a television screen', 0.80, { x: 0.252, y: 0.1, width: 0.08, height: 0.2 })
], 46_000);
annotateDetectionCertainty([], 48_000);
const tvC = annotateDetectionCertainty([
  detection('tv-c-new', 'a television screen', 0.82, { x: 0.55, y: 0.1, width: 0.08, height: 0.2 })
], 49_000);
const tvBAgain = annotateDetectionCertainty([
  detection('tv-b-again', 'a television screen', 0.80, { x: 0.252, y: 0.1, width: 0.08, height: 0.2 })
], 50_000);
assert.notEqual(tvC[0].object_track_id, tvBAgain[0].object_track_id, 'new tracks must not collide with surviving same-class track IDs');
assert.equal(tvBAgain[0].certainty, 'confirmed', 'surviving same-class track must not be overwritten by a new track');

resetObjectTemporalTracks();
const crowdedTvFrame = parseYoloDetectionFrame({
  frame_width: 1280,
  frame_height: 720,
  detections: [
    { class_id: 99, type: 'object', label: 'a television screen', confidence: 0.91, bbox: { x: 0.05, y: 0.1, width: 0.08, height: 0.2 } },
    { class_id: 99, type: 'object', label: 'a television screen', confidence: 0.89, bbox: { x: 0.25, y: 0.1, width: 0.08, height: 0.2 } },
    { class_id: 99, type: 'object', label: 'a television screen', confidence: 0.87, bbox: { x: 0.55, y: 0.1, width: 0.08, height: 0.2 } }
  ]
}, new Date(60_000).toISOString(), { frame_sequence: 60 });
assert.equal(crowdedTvFrame.detections.length, 2, 'YAML per-class max_boxes must cap confirmed same-class objects');
assert.deepEqual(crowdedTvFrame.detections.map((entry) => entry.id), ['yolo_1280_720_0', 'yolo_1280_720_1'], 'per-class max_boxes keeps the highest-confidence valid objects');
assert.equal(crowdedTvFrame.dropped_detections.max_per_class, 1, 'per-class max_boxes increments max_per_class drop count');

resetObjectTemporalTracks();
const lowButConfiguredTvFrame = parseYoloDetectionFrame({
  frame_width: 1280,
  frame_height: 720,
  detections: [
    { class_id: 99, type: 'object', label: 'a television screen', confidence: 0.333, bbox: { x: 0.54, y: 0.20, width: 0.07, height: 0.13 }, source: 'grounding_dino', proposal_sources: ['grounding_dino'] }
  ]
}, new Date(70_000).toISOString(), { frame_sequence: 70 });
assert.equal(lowButConfiguredTvFrame.detections.length, 1, 'raw object normalization must use YAML per-class initial confidence instead of only the global threshold');
assert.equal(lowButConfiguredTvFrame.detections[0].object_track_class, 'television');
assert.equal(lowButConfiguredTvFrame.detections[0].certainty, 'uncertain', 'low configured TV candidate is admitted for temporal confirmation, not immediately rendered');
const combinedMonitorPhrase = objectClassForDetection(detection(
  'combined-monitor',
  'screen a computer monitor',
  0.48,
  { x: 0.22, y: 0.63, width: 0.04, height: 0.13 },
  { source: 'grounding_dino', proposal_sources: ['grounding_dino'] }
));
assert.equal(combinedMonitorPhrase.canonical, 'monitor', 'combined screen/monitor phrases must use the stricter YAML monitor class');
assert.equal(
  objectPolicyDisposition({
    label: 'screen a computer monitor',
    type: 'object',
    confidence: 0.48,
    bbox: { x: 0.22, y: 0.63, width: 0.04, height: 0.13 },
    certainty: 'confirmed'
  }).allowed,
  false,
  'combined screen/monitor false positives must not inherit the lower pure-TV policy'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_VISION_DETECTION_FRAME_CONTRACT_PASS',
  frame_replacement: true,
  out_of_order_dropped: true,
  stale_cleared: true,
  duplicate_suppression: true,
  yaml_thresholds_loaded: true,
  object_class_policy_loaded: true,
  object_temporal_confirmation: true
}, null, 2));
