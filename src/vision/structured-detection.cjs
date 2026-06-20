'use strict';

/**
 * Structured vision detection schema for Floki-v2
 * 
 * Detections use normalized 0-1 coordinates relative to frame dimensions
 * This allows scalable rendering across different video resolutions and display sizes
 */

function validateBox(box, frameWidth, frameHeight) {
  if (!box || typeof box !== 'object') return { valid: false, error: 'box must be an object' };
  if (!Number.isFinite(box.x) || box.x < 0 || box.x > 1) return { valid: false, error: 'box.x must be finite 0-1' };
  if (!Number.isFinite(box.y) || box.y < 0 || box.y > 1) return { valid: false, error: 'box.y must be finite 0-1' };
  if (!Number.isFinite(box.width) || box.width <= 0 || box.width > 1) return { valid: false, error: 'box.width must be finite >0 and <=1' };
  if (!Number.isFinite(box.height) || box.height <= 0 || box.height > 1) return { valid: false, error: 'box.height must be finite >0 and <=1' };
  
  const x2 = box.x + box.width;
  const y2 = box.y + box.height;
  if (x2 > 1) return { valid: false, error: 'box.x + box.width must be <= 1' };
  if (y2 > 1) return { valid: false, error: 'box.y + box.height must be <= 1' };
  
  return { valid: true };
}

function validateDetection(detection, frameWidth, frameHeight) {
  if (!detection || typeof detection !== 'object') return { valid: false, error: 'detection must be an object' };
  if (detection.id != null && typeof detection.id !== 'string') return { valid: false, error: 'detection.id must be a string if present' };
  if (typeof detection.type !== 'string') return { valid: false, error: 'detection.type is required' };
  if (!['object', 'face', 'person', 'body'].includes(detection.type)) return { valid: false, error: 'detection.type must be object|face|person|body' };
  if (typeof detection.label !== 'string') return { valid: false, error: 'detection.label is required' };
  if (detection.label.length > 256) return { valid: false, error: 'detection.label must be <=256 chars' };
  
  const conf = Number(detection.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return { valid: false, error: 'detection.confidence must be finite 0-1' };
  
  const boxResult = validateBox(detection.bbox, frameWidth, frameHeight);
  if (!boxResult.valid) return { valid: false, error: `detection.bbox: ${boxResult.error}` };
  
  return { valid: true };
}

function validateDetectionArray(detections, frameWidth, frameHeight, maxCount = 100) {
  if (!Array.isArray(detections)) return { valid: false, error: 'detections must be an array' };
  if (detections.length > maxCount) return { valid: false, error: `detections array exceeds max count of ${maxCount}` };
  
  for (let i = 0; i < detections.length; i++) {
    const result = validateDetection(detections[i], frameWidth, frameHeight);
    if (!result.valid) return { valid: false, error: `detections[${i}]: ${result.error}` };
  }
  
  return { valid: true };
}

function createDetectionFrame({
  frameId,
  capturedAt,
  width,
  height,
  objects = [],
  faces = [],
  scene = { label: '', confidence: 0 }
} = {}) {
  if (!Number.isInteger(frameId) || frameId < 0) throw new Error('frameId must be a non-negative integer');
  if (!Number.isInteger(width) || width <= 0) throw new Error('width must be a positive integer');
  if (!Number.isInteger(height) || height <= 0) throw new Error('height must be a positive integer');
  
  const sceneConf = Number(scene.confidence || 0);
  if (!Number.isFinite(sceneConf) || sceneConf < 0 || sceneConf > 1) {
    throw new Error('scene.confidence must be finite 0-1');
  }
  
  const now = new Date();
  
  return Object.freeze({
    schema_version: 'floki-v2-structured-detection-v1',
    frame_id: frameId,
    captured_at: capturedAt || now.toISOString(),
    image_width: width,
    image_height: height,
    objects: Array.isArray(objects) ? objects.map(d => Object.freeze(d)) : [],
    faces: Array.isArray(faces) ? faces.map(d => Object.freeze(d)) : [],
    scene: Object.freeze({
      label: String(scene.label || '').slice(0, 256),
      confidence: Math.max(0, Math.min(1, sceneConf))
    }),
    source: 'structured_detection',
    fresh: true,
    stale: false,
    age_ms: 0,
    validated_at: now.toISOString(),
    detection_count: (Array.isArray(objects) ? objects.length : 0) + (Array.isArray(faces) ? faces.length : 0),
    metadata: Object.freeze({
      created_at: now.toISOString(),
      frame_timestamp: capturedAt || now.toISOString(),
      detection_generated_at: now.toISOString()
    })
  });
}

function createDetection({ id, type, label, confidence, bbox } = {}) {
  if (typeof type !== 'string' || !['object', 'face', 'person', 'body'].includes(type)) {
    throw new Error('type must be one of: object, face, person, body');
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('label must be a non-empty string');
  }
  
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
    throw new Error('confidence must be finite 0-1');
  }
  
  const result = validateBox(bbox, 1, 1); // normalized coords
  if (!result.valid) {
    throw new Error(`bbox: ${result.error}`);
  }
  
  return Object.freeze({
    id: id || `detection_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`,
    type,
    label: label.slice(0, 256),
    confidence: Math.max(0, Math.min(1, conf)),
    bbox: Object.freeze({
      x: Number(bbox.x),
      y: Number(bbox.y),
      width: Number(bbox.width),
      height: Number(bbox.height)
    }),
    bbox_pixels: null // will be computed at render time if needed
  });
}

function createFaceDetection({ id, label, confidence, bbox } = {}) {
  return createDetection({ id, type: 'face', label, confidence, bbox });
}

function createObjectDetection({ id, label, confidence, bbox } = {}) {
  return createDetection({ id, type: 'object', label, confidence, bbox });
}

function pixelToPoint(px, py, frameWidth, frameHeight) {
  return Object.freeze({
    x: Math.max(0, Math.min(1, px / frameWidth)),
    y: Math.max(0, Math.min(1, py / frameHeight))
  });
}

function pixelsToNormalized(bboxPixels, frameWidth, frameHeight) {
  const x = bboxPixels.x;
  const y = bboxPixels.y;
  const w = bboxPixels.width;
  const h = bboxPixels.height;
  
  if (x < 0 || y < 0 || w <= 0 || h <= 0) {
    throw new Error('bboxPixels must have non-negative coordinates and positive dimensions');
  }
  if (x + w > frameWidth || y + h > frameHeight) {
    throw new Error('bboxPixels exceeds frame boundaries');
  }
  
  return Object.freeze({
    x: x / frameWidth,
    y: y / frameHeight,
    width: w / frameWidth,
    height: h / frameHeight
  });
}

function bboxToPixels(normalizedBox, frameWidth, frameHeight) {
  return Object.freeze({
    x: Math.round(normalizedBox.x * frameWidth),
    y: Math.round(normalizedBox.y * frameHeight),
    width: Math.round(normalizedBox.width * frameWidth),
    height: Math.round(normalizedBox.height * frameHeight)
  });
}

function markAsStale(detectionFrame, maxAgeMs = 5000) {
  const now = Date.now();
  const captured = Date.parse(detectionFrame.captured_at) || now;
  const age = now - captured;
  
  return Object.freeze({
    ...detectionFrame,
    stale: age > maxAgeMs,
    age_ms: age,
    validated_at: new Date().toISOString()
  });
}

function filterValidDetections(detections, frameWidth, frameHeight) {
  if (!Array.isArray(detections)) return [];
  return detections.filter(d => {
    const result = validateDetection(d, frameWidth, frameHeight);
    if (!result.valid) {
      console.warn(`Invalid detection filtered: ${result.error}`);
      return false;
    }
    return true;
  });
}

function mergeDetectionFrames(baseFrame, updateFrame) {
  if (!baseFrame || !updateFrame) return baseFrame || updateFrame;
  
  const objects = filterValidDetections(
    [...(baseFrame.objects || []), ...(updateFrame.objects || [])],
    baseFrame.image_width,
    baseFrame.image_height
  );
  
  const faces = filterValidDetections(
    [...(baseFrame.faces || []), ...(updateFrame.faces || [])],
    baseFrame.image_width,
    baseFrame.image_height
  );
  
  return Object.freeze({
    ...baseFrame,
    objects,
    faces,
    detection_count: objects.length + faces.length,
    merged_at: new Date().toISOString()
  });
}

module.exports = {
  validateBox,
  validateDetection,
  validateDetectionArray,
  createDetectionFrame,
  createDetection,
  createFaceDetection,
  createObjectDetection,
  pixelToPoint,
  pixelsToNormalized,
  bboxToPixels,
  markAsStale,
  filterValidDetections,
  mergeDetectionFrames,
  
  // Constants
  MAX_DETECTION_COUNT: 100,
  DEFAULT_MAX_AGE_MS: 5000,
  DETECTION_TYPES: ['object', 'face', 'person', 'body']
};

