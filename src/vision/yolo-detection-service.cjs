'use strict';

/**
 * YOLO Object Detection Service for Floki-v2
 * 
 * Consumes frames from the existing webcam pipeline and runs real YOLO inference
 * to produce structured bounding box detections for persons and objects.
 * All paths and settings are read from chat.config.yaml.
 */

const fs = require('fs');
const path = require('path');

const { getVisionConfig, getPathConfig, PROJECT_ROOT } = require('../config/floki-config.cjs');
const { ensureDirSync, writeJsonFileAtomicSync, existsSync } = require('../util/fs-safe.cjs');

/* Get detection configuration from YAML */
function getDetectionConfig() {
  return {
    enabled: getVisionConfig('chat').detection?.object_detector_enabled !== false,
    yoloModelPath: getVisionConfig('chat').detection?.yolo_model_path || '.floki-tools/models/yolo/yolo11n.pt',
    confidenceThreshold: Number(getVisionConfig('chat').detection?.detection_confidence_threshold || 0.5),
    detectionIntervalFrames: Number(getVisionConfig('chat').detection?.detection_interval_frames || 20),
    maxAgeMs: Number(getVisionConfig('chat').detection?.detection_max_age_ms || 5000),
    cudaEnabled: true
  };
}

/* Get absolute path for detection model */
function getYoloModelPath() {
  const config = getDetectionConfig();
  return path.join(PROJECT_ROOT, config.yoloModelPath);
}

/* Get Python environment path */
function getPythonPath() {
  return path.join(PROJECT_ROOT, '.floki-tools', 'venv-chat-embodiment', 'bin', 'python3');
}

/* Schema validation */
function validateDetection(detection, frameWidth, frameHeight) {
  if (!detection || typeof detection !== 'object') return { valid: false, error: 'detection must be an object' };
  if (detection.id != null && typeof detection.id !== 'string') return { valid: false, error: 'id must be string' };
  if (typeof detection.class_id !== 'number' || !Number.isInteger(detection.class_id)) return { valid: false, error: 'class_id must be integer' };
  if (typeof detection.type !== 'string') return { valid: false, error: 'type must be string' };
  if (typeof detection.label !== 'string') return { valid: false, error: 'label must be string' };
  if (detection.label.length > 256) return { valid: false, error: 'label must be <=256 chars' };
  
  const conf = Number(detection.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return { valid: false, error: 'confidence must be 0-1' };
  
  const bbox = detection.bbox;
  if (!bbox || typeof bbox !== 'object') return { valid: false, error: 'bbox must be object' };
  if (typeof bbox.x !== 'number' || bbox.x < 0 || bbox.x > 1) return { valid: false, error: 'bbox.x must be 0-1' };
  if (typeof bbox.y !== 'number' || bbox.y < 0 || bbox.y > 1) return { valid: false, error: 'bbox.y must be 0-1' };
  if (typeof bbox.width !== 'number' || bbox.width <= 0 || bbox.width > 1) return { valid: false, error: 'bbox.width must be >0 and <=1' };
  if (typeof bbox.height !== 'number' || bbox.height <= 0 || bbox.height > 1) return { valid: false, error: 'bbox.height must be >0 and <=1' };
  
  if (bbox.x + bbox.width > 1) return { valid: false, error: 'bbox.x + width must be <= 1' };
  if (bbox.y + bbox.height > 1) return { valid: false, error: 'bbox.y + height must be <= 1' };
  
  return { valid: true };
}

function validateDetectionFrame(frame) {
  if (!frame || typeof frame !== 'object') return { valid: false, error: 'frame must be object' };
  if (frame.schema_version !== 1) return { valid: false, error: 'schema_version must be 1' };
  if (typeof frame.frame_id !== 'string') return { valid: false, error: 'frame_id must be string' };
  if (!frame.captured_at) return { valid: false, error: 'captured_at is required' };
  if (!frame.detected_at) return { valid: false, error: 'detected_at is required' };
  if (typeof frame.image_width !== 'number' || frame.image_width <= 0) return { valid: false, error: 'image_width must be >0' };
  if (typeof frame.image_height !== 'number' || frame.image_height <= 0) return { valid: false, error: 'image_height must be >0' };
  if (typeof frame.device !== 'string') return { valid: false, error: 'device must be string' };
  if (typeof frame.model_source !== 'string') return { valid: false, error: 'model_source must be string' };
  if (!Array.isArray(frame.detections)) return { valid: false, error: 'detections must be array' };
  if (frame.detections.length > 100) return { valid: false, error: 'detections array exceeds 100' };
  
  for (let i = 0; i < frame.detections.length; i++) {
    const result = validateDetection(frame.detections[i], frame.image_width, frame.image_height);
    if (!result.valid) return { valid: false, error: `detections[${i}]: ${result.error}` };
  }
  
  if (typeof frame.stale !== 'boolean') return { valid: false, error: 'stale must be boolean' };
  if (typeof frame.age_ms !== 'number') return { valid: false, error: 'age_ms must be number' };
  
  return { valid: true };
}

function normalizeYoloDetection(yoloResult, frameWidth, frameHeight) {
  if (!yoloResult || !Array.isArray(yoloResult.detections)) return [];
  
  const detections = [];
  const threshold = getDetectionConfig().confidenceThreshold;
  
  for (let i = 0; i < yoloResult.detections.length; i++) {
    const d = yoloResult.detections[i];
    
    if (!d.confidence || d.confidence < threshold) continue;
    
    const conf = Number(d.confidence);
    if (!Number.isFinite(conf)) continue;
    
    const bbox = d.bbox;
    if (!bbox || !Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || 
        !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)) {
      continue;
    }
    
    detections.push({
      id: `yolo_${frameWidth}_${frameHeight}_${i}`,
      class_id: Number(d.class_id || 0),
      type: String(d.type || 'object'),
      label: String(d.label || d.type || 'object'),
      confidence: Math.max(0, Math.min(1, conf)),
      bbox: {
        x: Math.max(0, Math.min(1, bbox.x)),
        y: Math.max(0, Math.min(1, bbox.y)),
        width: Math.max(0, Math.min(1, bbox.width)),
        height: Math.max(0, Math.min(1, bbox.height))
      }
    });
  }
  
  return detections;
}

function parseYoloDetectionFrame(yoloResult, capturedAt) {
  if (!yoloResult || typeof yoloResult !== 'object') {
    return { ok: false, marker: 'INVALID_YOLO_RESULT' };
  }
  
  const frameId = `frame_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const modelPath = getYoloModelPath();
  
  const detections = normalizeYoloDetection(yoloResult, yoloResult.frame_width, yoloResult.frame_height);
  
  const now = new Date();
  
  return {
    ok: true,
    schema_version: 1,
    frame_id: frameId,
    captured_at: capturedAt || now.toISOString(),
    detected_at: now.toISOString(),
    image_width: Number(yoloResult.frame_width || 1280),
    image_height: Number(yoloResult.frame_height || 720),
    device: String(yoloResult.device || 'cpu'),
    model_source: modelPath,
    detections: detections,
    stale: false,
    age_ms: 0
  };
}

function storeDetectionResult(detectionFrame, options = {}) {
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
  const detectionFile = path.join(runtimeDir, 'chat-webcam-vision.latest-detection.json');
  
  const validation = validateDetectionFrame(detectionFrame);
  if (!validation.valid) {
    console.error(`YOLO detection validation failed: ${validation.error}`);
    return { ok: false, marker: 'YOLO_DETECTION_STORE_FAIL', error: validation.error };
  }
  
  ensureDirSync(runtimeDir);
  writeJsonFileAtomicSync(detectionFile, detectionFrame);
  
  const heartbeatFile = path.join(runtimeDir, 'yolo-detection.heartbeat.json');
  const heartbeat = {
    service_heartbeat: new Date().toISOString(),
    last_detection_frame_id: detectionFrame.frame_id,
    last_detection_at: detectionFrame.detected_at,
    detection_count: detectionFrame.detections.length
  };
  writeJsonFileAtomicSync(heartbeatFile, heartbeat);
  
  return { 
    ok: true, 
    marker: 'FLOKI_V2_CHAT_YOLO_DETECTION_STORED', 
    detection_file: detectionFile,
    detection_count: detectionFrame.detections.length
  };
}

function readLatestDetection(options = {}) {
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
  const detectionFile = path.join(runtimeDir, 'chat-webcam-vision.latest-detection.json');
  
  if (!existsSync(detectionFile)) {
    return { 
      available: false, 
      stale: true, 
      age_ms: null,
      detection_file: detectionFile,
      marker: 'NO_DETECTION_FILE' 
    };
  }
  
  try {
    const content = fs.readFileSync(detectionFile, 'utf8');
    const detection = JSON.parse(content);
    
    const validation = validateDetectionFrame(detection);
    if (!validation.valid) {
      return {
        available: false,
        stale: false,
        age_ms: Date.now() - (Date.parse(detection.detected_at) || Date.now()),
        detection_file: detectionFile,
        marker: 'INVALID_DETECTION',
        error: validation.error
      };
    }
    
    const maxAgeMs = getDetectionConfig().maxAgeMs;
    const ageMs = Date.now() - (Date.parse(detection.detected_at) || Date.now());
    const stale = ageMs > maxAgeMs;
    
    return {
      available: true,
      fresh: !stale,
      stale: stale,
      age_ms: ageMs,
      detection_file: detectionFile,
      detection: detection,
      marker: 'FLOKI_V2_CHAT_YOLO_DETECTION_AVAILABLE'
    };
  } catch (e) {
    return {
      available: false,
      stale: false,
      age_ms: null,
      detection_file: detectionFile,
      marker: 'DETECTION_READ_ERROR',
      error: e.message
    };
  }
}

function getDetectionStatus(options = {}) {
  const lastDetection = readLatestDetection(options);
  const config = getDetectionConfig();
  
  return {
    ok: true,
    marker: 'FLOKI_V2_CHAT_YOLO_DETECTION_READY',
    model_path: config.yoloModelPath,
    cuda_available: config.cudaEnabled,
    confidence_threshold: config.confidenceThreshold,
    last_detection_frame_id: lastDetection.detection ? lastDetection.detection.frame_id : null,
    last_detection_at: lastDetection.detection ? lastDetection.detection.detected_at : null,
    last_detection_age_ms: lastDetection.age_ms,
    fresh_detection: lastDetection.fresh,
    ready_for_chat: lastDetection.available,
    raw: lastDetection.detection || {}
  };
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getDetectionConfig,
  getYoloModelPath,
  getPythonPath,
  normalizeYoloDetection,
  parseYoloDetectionFrame,
  storeDetectionResult,
  readLatestDetection,
  getDetectionStatus,
  validateDetection,
  validateDetectionFrame,
  processAlive
};
