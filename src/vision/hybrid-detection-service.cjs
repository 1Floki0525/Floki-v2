'use strict';

const {
  getVisionConfig,
  getDetectionConfig: getYamlDetectionConfig
} = require('../config/floki-config.cjs');
const {
  runYoloDetectionOnFrame,
  stopYoloDetectionWorker
} = require('./yolo-detection-service.cjs');
const {
  runGroundingDinoOnFrame,
  stopGroundingDinoWorker
} = require('./grounding-dino-detection-service.cjs');

function getHybridDetectionConfig() {
  const detection = getYamlDetectionConfig('chat');
  return Object.freeze({
    enabled: detection.hybrid_detector_enabled === true,
    requireAllComponents: detection.hybrid_require_all_components !== false,
    mergeIouThreshold: Math.max(
      0,
      Math.min(1, Number(detection.hybrid_merge_iou_threshold || 0.60))
    )
  });
}

function boxIou(a, b) {
  if (!a || !b) return 0;
  const ax2 = Number(a.x) + Number(a.width);
  const ay2 = Number(a.y) + Number(a.height);
  const bx2 = Number(b.x) + Number(b.width);
  const by2 = Number(b.y) + Number(b.height);
  const left = Math.max(Number(a.x), Number(b.x));
  const top = Math.max(Number(a.y), Number(b.y));
  const right = Math.min(ax2, bx2);
  const bottom = Math.min(ay2, by2);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = Math.max(0, Number(a.width)) * Math.max(0, Number(a.height));
  const areaB = Math.max(0, Number(b.width)) * Math.max(0, Number(b.height));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function isPersonCandidate(detection) {
  const label = String(detection && (detection.label || detection.type) || '')
    .trim()
    .toLowerCase();
  return Number(detection && detection.class_id) === 0 ||
    label === 'person' ||
    label.includes('human');
}

function semanticGroup(detection) {
  if (isPersonCandidate(detection)) return 'person';
  return String(detection && detection.label || 'object').trim().toLowerCase();
}

function proposalSources(detection) {
  const values = Array.isArray(detection && detection.proposal_sources)
    ? detection.proposal_sources
    : [detection && detection.source || 'yolo'];
  return [...new Set(values.map(String).filter(Boolean))];
}

function fuseDetections(yoloDetections, dinoDetections, threshold) {
  const fused = [];
  for (const rawDetection of [
    ...yoloDetections.map((item) => ({ ...item, source: item.source || 'yolo' })),
    ...dinoDetections
  ]) {
    const detection = {
      ...rawDetection,
      proposal_sources: proposalSources(rawDetection)
    };
    const match = fused.find((existing) => {
      return semanticGroup(existing) === semanticGroup(detection) &&
        boxIou(existing.bbox, detection.bbox) >= threshold;
    });

    if (!match) {
      fused.push(detection);
      continue;
    }

    match.confidence = Math.max(
      Number(match.confidence || 0),
      Number(detection.confidence || 0)
    );
    match.proposal_sources = [...new Set([
      ...proposalSources(match),
      ...proposalSources(detection)
    ])];
    if (!match.visual_fingerprint && detection.visual_fingerprint) {
      match.visual_fingerprint = detection.visual_fingerprint;
    }
    if (!match.proposal_phrase && detection.proposal_phrase) {
      match.proposal_phrase = detection.proposal_phrase;
    }
  }
  return fused;
}

async function runHybridDetectionOnFrame(framePath) {
  const config = getHybridDetectionConfig();
  if (!config.enabled) {
    return Object.freeze({
      ok: false,
      marker: 'HYBRID_DETECTOR_DISABLED',
      error: 'Hybrid detection is disabled in YAML'
    });
  }

  const [yolo, dino] = await Promise.all([
    runYoloDetectionOnFrame(framePath),
    runGroundingDinoOnFrame(framePath)
  ]);

  if (config.requireAllComponents && (!yolo.ok || !dino.ok)) {
    return Object.freeze({
      ok: false,
      marker: 'HYBRID_DETECTION_COMPONENT_UNAVAILABLE',
      error: [
        yolo.ok ? null : `YOLO: ${String(yolo.error || yolo.marker)}`,
        dino.ok ? null : `Grounding DINO: ${String(dino.error || dino.marker)}`
      ].filter(Boolean).join('; '),
      components: { yolo, grounding_dino: dino }
    });
  }

  if (!yolo.ok || !dino.ok) {
    return Object.freeze({
      ok: false,
      marker: 'HYBRID_DETECTION_STRICT_COMPONENTS_REQUIRED',
      error: 'All configured detector components are mandatory',
      components: { yolo, grounding_dino: dino }
    });
  }

  const width = Number(yolo.frame_width || dino.frame_width || 1280);
  const height = Number(yolo.frame_height || dino.frame_height || 720);
  const detections = fuseDetections(
    Array.isArray(yolo.detections) ? yolo.detections : [],
    Array.isArray(dino.detections) ? dino.detections : [],
    config.mergeIouThreshold
  );

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_HYBRID_DETECTION_RESULT',
    frame_width: width,
    frame_height: height,
    device: `yolo:${String(yolo.device || 'unknown')};dino:${String(dino.device || 'unknown')}`,
    model_source: [
      String(yolo.model_source || 'YOLO'),
      String(dino.model_source || 'Grounding DINO')
    ].join(' + '),
    detections,
    components: Object.freeze({
      yolo_count: Array.isArray(yolo.detections) ? yolo.detections.length : 0,
      grounding_dino_count: Array.isArray(dino.detections) ? dino.detections.length : 0,
      strict_components_ready: true
    })
  });
}

function stopHybridDetectionWorkers() {
  return Object.freeze({
    yolo: stopYoloDetectionWorker(),
    grounding_dino: stopGroundingDinoWorker()
  });
}

module.exports = {
  getHybridDetectionConfig,
  boxIou,
  fuseDetections,
  runHybridDetectionOnFrame,
  stopHybridDetectionWorkers
};
