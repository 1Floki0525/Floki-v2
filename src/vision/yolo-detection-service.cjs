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
const {
  spawn } = require('child_process');

const { getVisionConfig,
  getPathConfig,
  PROJECT_ROOT,
  getDetectionConfig: getYamlDetectionConfig
} = require('../config/floki-config.cjs');
const { ensureDirSync, writeJsonFileAtomicSync, existsSync } = require('../util/fs-safe.cjs');

/* Persistent YOLO Python worker state */
let yoloWorkerProcess = null;
let yoloWorkerReady = false;
let yoloWorkerDevice = 'unknown';
let yoloPendingResolve = null;
let yoloPendingReject = null;
let yoloPendingTimeout = null;
let yoloPendingFrameId = null;
let yoloWorkerBuffer = '';
let yoloWorkerStopped = false;
let yoloWorkerSpawnCount = 0;

const YOLO_WORKER_TIMEOUT_MS = 30000;
const YOLO_MAX_RESTARTS = 3;

function settlePendingYoloFailure(marker, error, expectedFrameId = null) {
  if (!yoloPendingResolve) return false;
  if (
    expectedFrameId !== null &&
    yoloPendingFrameId !== expectedFrameId
  ) {
    return false;
  }

  const resolve = yoloPendingResolve;
  yoloPendingResolve = null;
  yoloPendingReject = null;
  yoloPendingFrameId = null;

  if (yoloPendingTimeout) {
    clearTimeout(yoloPendingTimeout);
    yoloPendingTimeout = null;
  }

  resolve({
    ok: false,
    marker,
    error: String(error || marker)
  });

  return true;
}

/* Start persistent YOLO Python worker process */
function startYoloDetectionWorker(options = {}) {
  if (yoloWorkerProcess && yoloWorkerReady) {
    return { ok: true, marker: 'YOLO_WORKER_ALREADY_RUNNING', device: yoloWorkerDevice };
  }
  if (yoloWorkerProcess) {
    stopYoloDetectionWorker();
  }

  yoloWorkerStopped = false;
  yoloWorkerSpawnCount += 1;
  yoloWorkerBuffer = '';

  const pythonPath = options.python_path || getPythonPath();
  const workerScript = path.join(PROJECT_ROOT, '.floki-tools', 'yolo-config', 'yolo-worker.py');
  const modelPath = options.yolo_model_path || getYoloModelPath();

  if (!existsSync(workerScript)) {
    return { ok: false, marker: 'YOLO_WORKER_SCRIPT_MISSING', error: `Worker script not found at ${workerScript}` };
  }
  if (!existsSync(modelPath)) {
    return { ok: false, marker: 'YOLO_MODEL_MISSING', error: `YOLO model not found at ${modelPath}` };
  }

  try {
    const worker = spawn(pythonPath, [workerScript], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FLOKI_YOLO_MODEL: modelPath,
        PYTHONUNBUFFERED: '1'
      }
    });
    yoloWorkerProcess = worker;

    // Writable stream errors such as EPIPE are emitted asynchronously and are
    // not caught by try/catch around stdin.write(). Handle them explicitly so
    // detector shutdown or worker replacement cannot crash the webcam service.
    if (worker.stdin) {
      worker.stdin.on('error', (error) => {
        if (
          !yoloWorkerStopped &&
          (!error || error.code !== 'EPIPE')
        ) {
          console.error(
            '[YOLO-WORKER] stdin error: ' +
            String(error && error.message ? error.message : error)
          );
        }

        settlePendingYoloFailure(
          'YOLO_STDIN_ERROR',
          error && error.message
            ? error.message
            : 'YOLO worker stdin closed'
        );
      });
    }

    worker.stdout.on('data', (chunk) => {
      yoloWorkerBuffer += chunk.toString();
      processYoloWorkerLines();
    });

    worker.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[YOLO-WORKER] ${text}`);
    });

    worker.on('error', (err) => {
      console.error(`[YOLO-WORKER] Process error: ${err.message}`);
      yoloWorkerReady = false;
      if (!yoloWorkerStopped && yoloWorkerSpawnCount <= YOLO_MAX_RESTARTS) {
        setTimeout(() => startYoloDetectionWorker(options), 1000);
      }
    });

    worker.on('exit', (code, signal) => {
      console.error(`[YOLO-WORKER] Exited code=${code} signal=${signal}`);
      if (yoloPingTimer) { clearTimeout(yoloPingTimer); yoloPingTimer = null; }
      yoloWorkerReady = false;
      if (yoloWorkerProcess === worker) yoloWorkerProcess = null;
      if (yoloPendingResolve) {
        const resolve = yoloPendingResolve;
        yoloPendingResolve = null;
        yoloPendingReject = null;
        yoloPendingFrameId = null;
        if (yoloPendingTimeout) { clearTimeout(yoloPendingTimeout); yoloPendingTimeout = null; }
        resolve({ ok: false, marker: 'YOLO_WORKER_EXITED', error: `YOLO worker exited (code=${code}, signal=${signal || 'none'})` });
      }
    });

    pingYoloWorkerUntilReady();
    return { ok: true, marker: 'YOLO_WORKER_SPAWNED', pid: worker.pid };
  } catch (err) {
    yoloWorkerProcess = null;
    return { ok: false, marker: 'YOLO_WORKER_SPAWN_FAIL', error: err.message };
  }
}
let yoloPingTimer = null;

function pingYoloWorkerUntilReady() {
  const worker = yoloWorkerProcess;
  const stdin = worker && worker.stdin;

  if (
    yoloWorkerReady ||
    !worker ||
    !stdin ||
    stdin.destroyed ||
    stdin.writableEnded ||
    stdin.writable !== true ||
    yoloWorkerStopped
  ) {
    return;
  }

  try {
    stdin.write(
      JSON.stringify({ type: 'ping' }) + '\n',
      () => {}
    );
  } catch (_) {
    // The stdin error listener handles asynchronous stream failures.
  }

  yoloPingTimer = setTimeout(
    pingYoloWorkerUntilReady,
    500
  );
}

function stopYoloDetectionWorker() {
  yoloWorkerStopped = true;
  if (yoloPingTimer) { clearTimeout(yoloPingTimer); yoloPingTimer = null; }
  if (yoloPendingTimeout) { clearTimeout(yoloPendingTimeout); yoloPendingTimeout = null; }
  if (yoloPendingResolve) {
    const resolve = yoloPendingResolve;
    yoloPendingResolve = null;
    yoloPendingReject = null;
    yoloPendingFrameId = null;
    resolve({ ok: false, marker: 'YOLO_WORKER_STOPPED', error: 'Worker stopped' });
  }

  const worker = yoloWorkerProcess;
  yoloWorkerProcess = null;
  yoloWorkerReady = false;
  if (!worker) return { ok: true, marker: 'YOLO_WORKER_ALREADY_STOPPED', pid: null };

  try {
    if (worker.stdin && !worker.stdin.destroyed) {
      worker.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
    }
  } catch (_) { /* ignore */ }
  try { worker.kill('SIGTERM'); } catch (_) { /* ignore */ }

  const killTimer = setTimeout(() => {
    try {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    } catch (_) { /* ignore */ }
  }, 2000);
  if (typeof killTimer.unref === 'function') killTimer.unref();

  return { ok: true, marker: 'YOLO_WORKER_STOP_REQUESTED', pid: worker.pid || null };
}
function processYoloWorkerLines() {
  while (true) {
    const nl = yoloWorkerBuffer.indexOf('\n');
    if (nl < 0) break;

    const line = yoloWorkerBuffer.slice(0, nl).trim();
    yoloWorkerBuffer = yoloWorkerBuffer.slice(nl + 1);
    if (!line) continue;

    try {
      const msg = JSON.parse(line);

      if (msg.type === 'pong') {
        yoloWorkerReady = true;
        yoloWorkerDevice = msg.device || 'unknown';
        yoloWorkerSpawnCount = 0;
        continue;
      }

      if (msg.type === 'result') {
        if (yoloPendingFrameId && msg.frame_id !== yoloPendingFrameId) {
          continue;
        }
        if (yoloPendingTimeout) { clearTimeout(yoloPendingTimeout); yoloPendingTimeout = null; }
        if (yoloPendingResolve) {
          const resolve = yoloPendingResolve;
          yoloPendingResolve = null;
          yoloPendingReject = null;
          yoloPendingFrameId = null;
          resolve(msg);
        }
        continue;
      }

      if (msg.type === 'error') {
        console.error(`[YOLO-WORKER] ${msg.message}`);
        if (yoloPendingResolve && (!msg.frame_id || msg.frame_id === yoloPendingFrameId)) {
          const resolve = yoloPendingResolve;
          yoloPendingResolve = null;
          yoloPendingReject = null;
          yoloPendingFrameId = null;
          if (yoloPendingTimeout) { clearTimeout(yoloPendingTimeout); yoloPendingTimeout = null; }
          resolve({ ok: false, marker: 'YOLO_WORKER_ERROR', error: String(msg.message || 'YOLO worker error') });
        }
        continue;
      }
    } catch (e) {
      console.error(`[YOLO-WORKER] Parse error: ${e.message}, line: ${line.slice(0, 200)}`);
    }
  }
}

function ensureYoloWorkerStarted(options = {}) {
  if (yoloWorkerProcess && yoloWorkerReady) return { ok: true, marker: 'YOLO_WORKER_READY' };

  const startResult = startYoloDetectionWorker(options);
  if (!startResult.ok) return startResult;

  return waitForYoloWorkerReady(options);
}

function waitForYoloWorkerReady(options = {}) {
  const timeout = Number(options.worker_start_timeout || 15000);
  const started = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      if (yoloWorkerReady) {
        resolve({ ok: true, marker: 'YOLO_WORKER_READY', device: yoloWorkerDevice });
        return;
      }
      if (Date.now() - started > timeout) {
        resolve({ ok: false, marker: 'YOLO_WORKER_START_TIMEOUT', error: 'Worker did not become ready' });
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/* Run YOLO detection on a frame file path.
 * Returns a promise resolving to structured detection result.
 */
async function runYoloDetectionOnFrame(framePath, options = {}) {
  if (yoloWorkerStopped) {
    return { ok: false, marker: 'YOLO_WORKER_STOPPED', error: 'Worker has been stopped' };
  }

  const ready = ensureYoloWorkerStarted(options);
  if (ready.then) {
    const result = await ready;
    if (!result.ok) return result;
  } else if (!ready.ok) {
    return ready;
  }

  if (!existsSync(framePath)) {
    return { ok: false, marker: 'FRAME_NOT_FOUND', error: `Frame not found: ${framePath}` };
  }

  const frameId = `frame_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const config = getDetectionConfig();

  const worker = yoloWorkerProcess;
  const stdin = worker && worker.stdin;

  if (
    !worker ||
    !stdin ||
    stdin.destroyed ||
    stdin.writableEnded ||
    stdin.writable !== true
  ) {
    return {
      ok: false,
      marker: 'YOLO_WORKER_NOT_AVAILABLE',
      error: 'Worker process stdin is not writable'
    };
  }

  return new Promise((resolve, reject) => {
    if (yoloPendingResolve) {
      const previousResolve = yoloPendingResolve;
      yoloPendingResolve = null;
      yoloPendingReject = null;
      yoloPendingFrameId = null;
      if (yoloPendingTimeout) { clearTimeout(yoloPendingTimeout); yoloPendingTimeout = null; }
      previousResolve({ ok: false, marker: 'FRAME_SKIPPED', error: 'Superseded by newer frame' });
    }

    yoloPendingResolve = resolve;
    yoloPendingReject = reject;
    yoloPendingFrameId = frameId;

    yoloPendingTimeout = setTimeout(() => {
      if (yoloPendingResolve) {
        const r = yoloPendingResolve;
        yoloPendingResolve = null;
        yoloPendingReject = null;
        yoloPendingFrameId = null;
        r({ ok: false, marker: 'YOLO_TIMEOUT', error: `Inference timed out after ${YOLO_WORKER_TIMEOUT_MS}ms` });
      }
    }, YOLO_WORKER_TIMEOUT_MS);

    const cmd = JSON.stringify({
      type: 'detect',
      frame_path: framePath,
      frame_id: frameId,
      confidence: Math.min(config.confidenceThreshold, config.personCandidateConfidenceThreshold)
    });

    const handleWriteFailure = (error) => {
      settlePendingYoloFailure(
        'YOLO_STDIN_WRITE_FAIL',
        error && error.message
          ? error.message
          : 'YOLO worker stdin write failed',
        frameId
      );
    };

    try {
      stdin.write(cmd + '\n', (error) => {
        if (error) handleWriteFailure(error);
      });
    } catch (error) {
      handleWriteFailure(error);
    }
  });
}

/* Get detection configuration from YAML */
function getDetectionConfig() {
  const detection = getYamlDetectionConfig('chat');
  return {
    enabled: detection.object_detector_enabled !== false,
    yoloModelPath: detection.yolo_model_path || '.floki-tools/models/yolo/yolo11m.pt',
    confidenceThreshold: Number(detection.detection_confidence_threshold || 0.5),
    personCandidateConfidenceThreshold: Number(detection.person_candidate_confidence_threshold || 0.30),
    detectionIntervalFrames: Number(detection.detection_interval_frames || 5),
    detectionMinIntervalMs: Number(detection.detection_min_interval_ms || 500),
    maxAgeMs: Number(detection.detection_max_age_ms || 5000),
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
  const config = getDetectionConfig();

  for (let i = 0; i < yoloResult.detections.length; i++) {
    const d = yoloResult.detections[i];
    const label = String(d.label || d.type || '').toLowerCase();
    const personCandidate = Number(d.class_id) === 0 || label === 'person';
    const threshold = personCandidate
      ? config.personCandidateConfidenceThreshold
      : config.confidenceThreshold;

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
      source: String(d.source || 'yolo'),
      proposal_phrase: d.proposal_phrase ? String(d.proposal_phrase) : null,
      proposal_sources: Array.isArray(d.proposal_sources)
        ? d.proposal_sources.map(String)
        : [String(d.source || 'yolo')],
      visual_fingerprint: d.visual_fingerprint
        ? String(d.visual_fingerprint)
        : null,
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
    model_source: String(yoloResult.model_source || modelPath),
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
  const storedAt = new Date().toISOString();
  const storedFrame = Object.freeze({ ...detectionFrame, stored_at: storedAt });
  writeJsonFileAtomicSync(detectionFile, storedFrame);
  
  const heartbeatFile = path.join(runtimeDir, 'yolo-detection.heartbeat.json');
  const heartbeat = {
    service_heartbeat: storedAt,
    last_detection_frame_id: storedFrame.frame_id,
    last_detection_at: storedFrame.detected_at,
    last_detection_stored_at: storedAt,
    detection_count: storedFrame.detections.length
  };
  writeJsonFileAtomicSync(heartbeatFile, heartbeat);
  
  return { 
    ok: true, 
    marker: 'FLOKI_V2_CHAT_YOLO_DETECTION_STORED', 
    detection_file: detectionFile,
    detection_count: storedFrame.detections.length
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
    const freshnessTimestamp = detection.stored_at || detection.detected_at;
    const ageMs = Date.now() - (Date.parse(freshnessTimestamp) || Date.now());
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
  startYoloDetectionWorker,
  stopYoloDetectionWorker,
  runYoloDetectionOnFrame,
  normalizeYoloDetection,
  parseYoloDetectionFrame,
  storeDetectionResult,
  readLatestDetection,
  getDetectionStatus,
  validateDetection,
  validateDetectionFrame,
  processAlive
};
