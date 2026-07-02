'use strict';

const { getDetectionConfig: getYamlDetectionConfig } = require('../config/floki-config.cjs');

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeObjectClass(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^an?\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitAliases(value) {
  return String(value || '')
    .split('|')
    .map(normalizeObjectClass)
    .filter(Boolean);
}

function rawObjectPolicies(options = {}) {
  const detection = options.yaml || getYamlDetectionConfig('chat');
  const root = detection.object_class_policy || {};
  const defaults = root.default || {};
  const classes = root.classes || {};
  return { root, defaults, classes };
}

function numeric(value, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const source = value === undefined || value === null ? fallback : value;
  const number = Number(source);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || String(value).toLowerCase() === 'true';
}

function configuredObjectClassPolicy(options = {}) {
  const { defaults, classes } = rawObjectPolicies(options);
  const defaultPolicy = Object.freeze({
    initialMinConfidence: numeric(defaults.initial_min_confidence, 0.35, 0, 1),
    maintainMinConfidence: numeric(defaults.maintain_min_confidence, 0.30, 0, 1),
    confirmationFrames: Math.max(1, Math.floor(numeric(defaults.confirmation_frames, 2, 1))),
    confirmationWindowMs: Math.max(1, numeric(defaults.confirmation_window_ms, 5000, 1)),
    maxMissedFrames: Math.max(0, Math.floor(numeric(defaults.max_missed_frames, 1, 0))),
    maxMissedAgeMs: Math.max(1, numeric(defaults.max_missed_age_ms, 2500, 1)),
    minArea: numeric(defaults.min_area, 0, 0, 1),
    maxArea: numeric(defaults.max_area, 1, 0, 1),
    minAspectRatio: numeric(defaults.min_aspect_ratio, 0.05, 0.001),
    maxAspectRatio: numeric(defaults.max_aspect_ratio, 20, 0.001),
    temporalIouThreshold: clamp(defaults.temporal_iou_threshold ?? 0.25, 0, 1),
    maxBoxes: Math.max(1, Math.floor(numeric(defaults.max_boxes, 6, 1))),
    secondaryVerificationRequired: booleanValue(defaults.secondary_verification_required, false),
    renderUnconfirmed: booleanValue(defaults.render_unconfirmed, false)
  });
  const aliases = new Map();
  const policies = new Map();
  for (const [rawName, rawPolicy] of Object.entries(classes || {})) {
    const canonical = normalizeObjectClass(rawName);
    if (!canonical) continue;
    const policy = Object.freeze({
      ...defaultPolicy,
      canonical,
      initialMinConfidence: numeric(rawPolicy.initial_min_confidence, defaultPolicy.initialMinConfidence, 0, 1),
      maintainMinConfidence: numeric(rawPolicy.maintain_min_confidence, defaultPolicy.maintainMinConfidence, 0, 1),
      confirmationFrames: Math.max(1, Math.floor(numeric(rawPolicy.confirmation_frames, defaultPolicy.confirmationFrames, 1))),
      confirmationWindowMs: Math.max(1, numeric(rawPolicy.confirmation_window_ms, defaultPolicy.confirmationWindowMs, 1)),
      maxMissedFrames: Math.max(0, Math.floor(numeric(rawPolicy.max_missed_frames, defaultPolicy.maxMissedFrames, 0))),
      maxMissedAgeMs: Math.max(1, numeric(rawPolicy.max_missed_age_ms, defaultPolicy.maxMissedAgeMs, 1)),
      minArea: numeric(rawPolicy.min_area, defaultPolicy.minArea, 0, 1),
      maxArea: numeric(rawPolicy.max_area, defaultPolicy.maxArea, 0, 1),
      minAspectRatio: numeric(rawPolicy.min_aspect_ratio, defaultPolicy.minAspectRatio, 0.001),
      maxAspectRatio: numeric(rawPolicy.max_aspect_ratio, defaultPolicy.maxAspectRatio, 0.001),
      temporalIouThreshold: clamp(rawPolicy.temporal_iou_threshold ?? defaultPolicy.temporalIouThreshold, 0, 1),
      maxBoxes: Math.max(1, Math.floor(numeric(rawPolicy.max_boxes, defaultPolicy.maxBoxes, 1))),
      secondaryVerificationRequired: booleanValue(rawPolicy.secondary_verification_required, defaultPolicy.secondaryVerificationRequired),
      renderUnconfirmed: booleanValue(rawPolicy.render_unconfirmed, defaultPolicy.renderUnconfirmed)
    });
    policies.set(canonical, policy);
    aliases.set(canonical, canonical);
    for (const alias of splitAliases(rawPolicy.aliases)) aliases.set(alias, canonical);
  }
  return Object.freeze({ defaultPolicy, aliases, policies });
}

function objectClassForDetection(detection, options = {}) {
  const config = configuredObjectClassPolicy(options);
  const label = normalizeObjectClass(detection && (detection.label || detection.proposal_phrase || detection.class || detection.name || detection.type));
  const canonical = config.aliases.get(label) || label || 'object';
  return Object.freeze({
    label,
    canonical,
    policy: config.policies.get(canonical) || Object.freeze({ ...config.defaultPolicy, canonical })
  });
}

function boxArea(box) {
  return Math.max(0, Number(box && box.width || 0)) * Math.max(0, Number(box && box.height || 0));
}

function boxAspectRatio(box) {
  return Math.max(0.001, Number(box && box.width || 0)) / Math.max(0.001, Number(box && box.height || 0));
}

function objectPolicyDisposition(detection, options = {}) {
  const resolved = objectClassForDetection(detection, options);
  const policy = resolved.policy;
  const confidence = Number(detection && detection.confidence || 0);
  const area = boxArea(detection && detection.bbox);
  const aspect = boxAspectRatio(detection && detection.bbox);
  if (area < policy.minArea || area > policy.maxArea) {
    return Object.freeze({ allowed: false, reason: 'object_area_outside_class_policy', resolved });
  }
  if (aspect < policy.minAspectRatio || aspect > policy.maxAspectRatio) {
    return Object.freeze({ allowed: false, reason: 'object_aspect_ratio_outside_class_policy', resolved });
  }
  const retained = detection && detection.retained_track === true ||
    detection && detection.object_policy_phase === 'maintain' ||
    options.phase === 'maintain';
  const threshold = retained ? policy.maintainMinConfidence : policy.initialMinConfidence;
  if (confidence < threshold) {
    return Object.freeze({ allowed: false, reason: 'object_confidence_below_class_policy', resolved });
  }
  if (detection && detection.certainty === 'uncertain' && policy.renderUnconfirmed !== true) {
    return Object.freeze({ allowed: false, reason: 'object_temporal_confirmation_pending', resolved });
  }
  if (policy.secondaryVerificationRequired) {
    const verification = detection && detection.object_verification;
    if (!verification || verification.verifier_ok !== true || verification.classification !== 'confirmed_class') {
      return Object.freeze({ allowed: false, reason: 'object_secondary_verification_required', resolved });
    }
  }
  return Object.freeze({ allowed: true, reason: 'accepted', resolved });
}

module.exports = {
  normalizeObjectClass,
  configuredObjectClassPolicy,
  objectClassForDetection,
  objectPolicyDisposition,
  boxArea,
  boxAspectRatio
};
