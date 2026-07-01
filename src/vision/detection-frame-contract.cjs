'use strict';

const { getDetectionConfig: getYamlDetectionConfig } = require('../config/floki-config.cjs');
const { classifyVerifiedDetectionForDisplay } = require('./person-presence-verifier.cjs');

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function configuredDetectionFramePolicy(options = {}) {
  const yaml = options.yaml || getYamlDetectionConfig('chat');
  return Object.freeze({
    minConfidence: clamp(Number(options.min_confidence ?? yaml.detection_min_confidence ?? yaml.detection_confidence_threshold), 0, 1),
    personMinConfidence: clamp(Number(options.person_min_confidence ?? yaml.person_min_confidence ?? yaml.person_candidate_confidence_threshold), 0, 1),
    faceMinConfidence: clamp(Number(options.face_min_confidence ?? yaml.face_min_confidence ?? yaml.detection_min_confidence ?? yaml.detection_confidence_threshold), 0, 1),
    iouThreshold: clamp(Number(options.iou_threshold ?? yaml.detection_nms_iou_threshold), 0, 1),
    maxBoxesPerFrame: Math.max(1, Number(options.max_boxes_per_frame ?? yaml.detection_max_boxes_per_frame)),
    maxBoxesPerClass: Math.max(1, Number(options.max_boxes_per_class ?? yaml.detection_max_boxes_per_class)),
    maxBoxesByClass: options.max_boxes_by_class || null,
    maxAgeMs: Math.max(1, Number(options.max_age_ms ?? yaml.detection_result_max_age_ms ?? yaml.detection_max_age_ms)),
    outOfOrderDropEnabled: options.out_of_order_drop_enabled ?? yaml.detection_out_of_order_drop_enabled !== false
  });
}

function normalizedLabel(detection) {
  return String(detection && (detection.label || detection.class || detection.name || detection.type) || 'object')
    .replace(/^an?\s+/i, '')
    .trim()
    .toLowerCase();
}

function detectionKind(detection) {
  const label = normalizedLabel(detection);
  if (Number(detection && detection.class_id) === 0 || label === 'person' || label === 'human') return 'person';
  if (label === 'face' || String(detection && detection.type || '').toLowerCase() === 'face') return 'face';
  if (detection && detection.object_track_class) return normalizedLabel({ label: detection.object_track_class });
  return label || 'object';
}

function maxBoxesForKind(kind, detection, policy) {
  const configured = policy.maxBoxesByClass;
  if (configured && typeof configured === 'object') {
    const direct = configured.get ? configured.get(kind) : configured[kind];
    const value = Number(direct);
    if (Number.isFinite(value) && value > 0) return Math.max(1, Math.floor(value));
  }
  const detectionLimit = Number(detection && detection.object_policy_max_boxes);
  if (Number.isFinite(detectionLimit) && detectionLimit > 0) return Math.max(1, Math.floor(detectionLimit));
  return policy.maxBoxesPerClass;
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = finiteNumber(box.x);
  const y = finiteNumber(box.y);
  const width = finiteNumber(box.width);
  const height = finiteNumber(box.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (x > 1 || y > 1 || width > 1 || height > 1) return null;
  if (x + width > 1 || y + height > 1) return null;
  return Object.freeze({ x, y, width, height });
}

function boxIou(leftBox, rightBox) {
  const left = normalizeBox(leftBox);
  const right = normalizeBox(rightBox);
  if (!left || !right) return 0;
  const leftRight = left.x + left.width;
  const leftBottom = left.y + left.height;
  const rightRight = right.x + right.width;
  const rightBottom = right.y + right.height;
  const width = Math.max(0, Math.min(leftRight, rightRight) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(left.y, right.y));
  const intersection = width * height;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectionThreshold(kind, policy) {
  if (kind === 'person') return policy.personMinConfidence;
  if (kind === 'face') return policy.faceMinConfidence;
  return policy.minConfidence;
}

function detectionMinimumConfidence(detection, kind, policy) {
  const objectPolicyMinimum = Number(detection && detection.object_policy_min_confidence);
  if (Number.isFinite(objectPolicyMinimum) && objectPolicyMinimum >= 0) {
    return clamp(objectPolicyMinimum, 0, 1);
  }
  return detectionThreshold(kind, policy);
}

function sanitizeDetection(detection, index, policy) {
  if (!detection || typeof detection !== 'object') return null;
  const box = normalizeBox(detection.bbox);
  if (!box) return null;
  const kind = detectionKind(detection);
  const confidence = finiteNumber(detection.confidence);
  if (confidence === null || confidence < detectionMinimumConfidence(detection, kind, policy)) return null;
  const id = detection.id ? String(detection.id) : `${kind}-${index}-${confidence.toFixed(4)}`;
  return Object.freeze({
    ...detection,
    id,
    confidence,
    bbox: box
  });
}

function suppressDuplicateDetections(detections, options = {}) {
  const policy = configuredDetectionFramePolicy(options);
  const dropped = {
    invalid: 0,
    low_confidence: 0,
    duplicates: 0,
    max_per_class: 0,
    max_per_frame: 0
  };
  const valid = [];
  for (let index = 0; index < (Array.isArray(detections) ? detections.length : 0); index += 1) {
    const raw = detections[index];
    const kind = detectionKind(raw);
    const confidence = finiteNumber(raw && raw.confidence);
    const sanitized = sanitizeDetection(raw, index, policy);
    if (!sanitized) {
      if (confidence !== null && confidence < detectionThreshold(kind, policy)) dropped.low_confidence += 1;
      else dropped.invalid += 1;
      continue;
    }
    valid.push(sanitized);
  }

  valid.sort((left, right) => {
    const confidenceDiff = Number(right.confidence || 0) - Number(left.confidence || 0);
    if (confidenceDiff !== 0) return confidenceDiff;
    return String(left.id).localeCompare(String(right.id));
  });

  const kept = [];
  const perClass = new Map();
  for (const detection of valid) {
    const kind = detectionKind(detection);
    const duplicate = kept.some((existing) =>
      detectionKind(existing) === kind &&
      boxIou(existing.bbox, detection.bbox) >= policy.iouThreshold
    );
    if (duplicate) {
      dropped.duplicates += 1;
      continue;
    }
    const classCount = Number(perClass.get(kind) || 0);
    if (classCount >= maxBoxesForKind(kind, detection, policy)) {
      dropped.max_per_class += 1;
      continue;
    }
    if (kept.length >= policy.maxBoxesPerFrame) {
      dropped.max_per_frame += 1;
      continue;
    }
    perClass.set(kind, classCount + 1);
    kept.push(detection);
  }

  kept.sort((left, right) => {
    const kindDiff = detectionKind(left).localeCompare(detectionKind(right));
    if (kindDiff !== 0) return kindDiff;
    return String(left.id).localeCompare(String(right.id));
  });

  return Object.freeze({
    detections: Object.freeze(kept),
    dropped: Object.freeze(dropped)
  });
}

function frameSequenceValue(frame) {
  const sequence = finiteNumber(frame && (frame.result_sequence ?? frame.frame_sequence));
  return sequence === null ? null : sequence;
}

function frameSessionValue(frame) {
  return String(frame && (frame.stream_session_id || frame.session_id || '') || '');
}

function frameAgeMs(frame, nowMs) {
  const detected = finiteNumber(frame && frame.detected_at_ms);
  const captured = finiteNumber(frame && frame.captured_at_ms);
  const timestamp = detected ?? captured ?? Date.parse(frame && (frame.detected_at || frame.captured_at) || '');
  if (Number.isFinite(timestamp)) return Math.max(0, Number(nowMs) - Number(timestamp));
  if (Number.isFinite(Number(frame && frame.age_ms))) return Math.max(0, Number(frame.age_ms));
  return Infinity;
}

function createInitialDetectionFrameState(options = {}) {
  return Object.freeze({
    streamSessionId: options.session_id || options.stream_session_id || null,
    acceptedSequence: null,
    acceptedFrameId: null,
    appliedSequences: Object.freeze([]),
    detections: Object.freeze([]),
    dropCounts: Object.freeze({
      stale: 0,
      outOfOrder: 0,
      duplicate: 0,
      session: 0,
      invalid: 0,
      suppressed: 0
    }),
    metadata: Object.freeze({})
  });
}

function nextDropCounts(state, key, amount = 1) {
  return Object.freeze({
    stale: Number(state.dropCounts && state.dropCounts.stale || 0) + (key === 'stale' ? amount : 0),
    outOfOrder: Number(state.dropCounts && state.dropCounts.outOfOrder || 0) + (key === 'outOfOrder' ? amount : 0),
    duplicate: Number(state.dropCounts && state.dropCounts.duplicate || 0) + (key === 'duplicate' ? amount : 0),
    session: Number(state.dropCounts && state.dropCounts.session || 0) + (key === 'session' ? amount : 0),
    invalid: Number(state.dropCounts && state.dropCounts.invalid || 0) + (key === 'invalid' ? amount : 0),
    suppressed: Number(state.dropCounts && state.dropCounts.suppressed || 0) + (key === 'suppressed' ? amount : 0)
  });
}

function withClearedDetections(state, key) {
  return Object.freeze({
    ...state,
    detections: Object.freeze([]),
    dropCounts: key ? nextDropCounts(state, key) : state.dropCounts
  });
}

function reduceDetectionFrameState(previousState, frame, options = {}) {
  const policy = configuredDetectionFramePolicy(options);
  const nowMs = Number(options.now_ms ?? Date.now());
  const previous = previousState || createInitialDetectionFrameState(options);
  if (!frame || typeof frame !== 'object') {
    return Object.freeze({ accepted: false, reason: 'missing_frame', state: withClearedDetections(previous, 'invalid') });
  }

  const session = frameSessionValue(frame);
  const currentSession = previous.streamSessionId || session || null;
  if (currentSession && session && session !== currentSession) {
    if (options.accept_new_session === true) {
      const reset = createInitialDetectionFrameState({ session_id: session });
      return reduceDetectionFrameState(reset, frame, { ...options, accept_new_session: false });
    }
    return Object.freeze({ accepted: false, reason: 'session_mismatch', state: withClearedDetections(previous, 'session') });
  }

  const ageMs = frameAgeMs(frame, nowMs);
  if (ageMs > policy.maxAgeMs || frame.stale === true) {
    return Object.freeze({ accepted: false, reason: 'stale_result', state: withClearedDetections(previous, 'stale') });
  }

  const sequence = frameSequenceValue(frame);
  const acceptedSequence = previous.acceptedSequence;
  if (
    policy.outOfOrderDropEnabled &&
    sequence !== null &&
    acceptedSequence !== null &&
    sequence < acceptedSequence
  ) {
    return Object.freeze({ accepted: false, reason: 'out_of_order', state: Object.freeze({ ...previous, dropCounts: nextDropCounts(previous, 'outOfOrder') }) });
  }
  if (
    sequence !== null &&
    acceptedSequence !== null &&
    sequence === acceptedSequence &&
    String(frame.frame_id || '') === String(previous.acceptedFrameId || '')
  ) {
    return Object.freeze({ accepted: false, reason: 'duplicate_sequence', state: Object.freeze({ ...previous, dropCounts: nextDropCounts(previous, 'duplicate') }) });
  }

  const suppressed = suppressDuplicateDetections(frame.detections, policy);
  const appliedSequences = sequence === null
    ? previous.appliedSequences
    : Object.freeze([...new Set([...(previous.appliedSequences || []), sequence])].slice(-128));
  const state = Object.freeze({
    streamSessionId: currentSession,
    acceptedSequence: sequence,
    acceptedFrameId: frame.frame_id || null,
    appliedSequences,
    detections: suppressed.detections,
    dropCounts: Object.freeze({
      ...previous.dropCounts,
      invalid: Number(previous.dropCounts && previous.dropCounts.invalid || 0) + suppressed.dropped.invalid,
      suppressed: Number(previous.dropCounts && previous.dropCounts.suppressed || 0) +
        suppressed.dropped.low_confidence +
        suppressed.dropped.duplicates +
        suppressed.dropped.max_per_class +
        suppressed.dropped.max_per_frame
    }),
    metadata: Object.freeze({
      frame_id: frame.frame_id || null,
      frame_sequence: frame.frame_sequence ?? null,
      result_sequence: frame.result_sequence ?? null,
      captured_at: frame.captured_at || null,
      detected_at: frame.detected_at || null,
      age_ms: ageMs,
      image_width: Number(frame.image_width || frame.source_width || 0),
      image_height: Number(frame.image_height || frame.source_height || 0),
      dropped: suppressed.dropped
    })
  });
  return Object.freeze({ accepted: true, reason: 'accepted', state });
}

function splitDisplayDetections(frame, options = {}) {
  const reduced = reduceDetectionFrameState(
    createInitialDetectionFrameState({
      session_id: frame && (frame.stream_session_id || frame.session_id)
    }),
    frame,
    { ...options, accept_new_session: true }
  );
  const objects = [];
  const persons = [];
  const faces = [];
  for (const detection of reduced.state.detections) {
    if (detectionKind(detection) === 'face') {
      faces.push(detection);
      continue;
    }
    const disposition = classifyVerifiedDetectionForDisplay(detection);
    if (disposition.bucket === 'persons') persons.push(disposition.detection);
    if (disposition.bucket === 'objects') objects.push(disposition.detection);
  }
  return Object.freeze({
    accepted: reduced.accepted,
    reason: reduced.reason,
    objects: Object.freeze(objects),
    persons: Object.freeze(persons),
    faces: Object.freeze(faces),
    state: reduced.state
  });
}

module.exports = {
  configuredDetectionFramePolicy,
  createInitialDetectionFrameState,
  reduceDetectionFrameState,
  suppressDuplicateDetections,
  splitDisplayDetections,
  normalizeBox,
  boxIou
};
