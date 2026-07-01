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
const { suppressDuplicateDetections } = require('./detection-frame-contract.cjs');
const {
  configuredObjectClassPolicy,
  boxArea,
  boxAspectRatio,
  objectClassForDetection,
  objectPolicyDisposition
} = require('./object-class-policy.cjs');

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

/* Object temporal confirmation state */
const objectTemporalTracks = new Map();
const objectTemporalTrackCounters = new Map();

function getTemporalConfirmationConfig() {
  const detection = getYamlDetectionConfig('chat');
  return Object.freeze({
    requiredFrames: Math.max(
      1,
      Number(detection.object_temporal_confirmation_frames || 2)
    ),
    windowMs: Math.max(
      1000,
      Number(detection.object_temporal_confirmation_window_ms || 5000)
    )
  });
}

function normalizedBoxIou(left, right) {
  const lx1 = Number(left && left.x || 0);
  const ly1 = Number(left && left.y || 0);
  const lx2 = lx1 + Number(left && left.width || 0);
  const ly2 = ly1 + Number(left && left.height || 0);
  const rx1 = Number(right && right.x || 0);
  const ry1 = Number(right && right.y || 0);
  const rx2 = rx1 + Number(right && right.width || 0);
  const ry2 = ry1 + Number(right && right.height || 0);
  const width = Math.max(0, Math.min(lx2, rx2) - Math.max(lx1, rx1));
  const height = Math.max(0, Math.min(ly2, ry2) - Math.max(ly1, ry1));
  const intersection = width * height;
  const union = Math.max(0, lx2 - lx1) * Math.max(0, ly2 - ly1) +
    Math.max(0, rx2 - rx1) * Math.max(0, ry2 - ry1) -
    intersection;
  return union > 0 ? intersection / union : 0;
}

function objectTrackKey(canonical) {
  const key = String(canonical || 'object');
  const next = Number(objectTemporalTrackCounters.get(key) || 0) + 1;
  objectTemporalTrackCounters.set(key, next);
  return key + ':' + String(next);
}

function annotateDetectionCertainty(detections, capturedAt) {
  if (!Array.isArray(detections)) return detections;
  const config = getTemporalConfirmationConfig();
  const now = typeof capturedAt === 'string'
    ? (Date.parse(capturedAt) || Date.now())
    : (Number(capturedAt) || Date.now());
  const windowStart = now - config.windowMs;
  const matchedTrackKeys = new Set();

  for (const [key, track] of objectTemporalTracks.entries()) {
    const policy = track.policy || {};
    const ageMs = now - Number(track.lastSeenAt || 0);
    if (track.lastSeenAt < windowStart && (!track.confirmed || ageMs > Number(policy.maxMissedAgeMs || config.windowMs))) {
      objectTemporalTracks.delete(key);
    }
  }

  const annotated = detections.map((detection) => {
    const label = String(detection.label || '').toLowerCase().trim();
    // Person candidates use VLM verification, not temporal object confirmation.
    const isPersonLabel = Number(detection.class_id) === 0 || label === 'person';
    if (isPersonLabel) {
      return { ...detection, certainty: 'confirmed' };
    }

    const resolved = objectClassForDetection(detection);
    const policy = resolved.policy;
    const match = [...objectTemporalTracks.entries()]
      .filter(([, track]) => track.canonical === resolved.canonical)
      .map(([key, track]) => ({ key, track, iou: normalizedBoxIou(track.bbox, detection.bbox) }))
      .filter((entry) =>
        now - Number(entry.track.lastSeenAt || 0) <= policy.confirmationWindowMs &&
        entry.iou >= policy.temporalIouThreshold
      )
      .sort((a, b) => b.iou - a.iou)[0] || null;
    const trackKey = match ? match.key : objectTrackKey(resolved.canonical);
    const existing = match ? match.track : null;
    const policyPhase = existing && existing.confirmed ? 'maintain' : 'initial';
    const eligible = objectPolicyDisposition(
      {
        ...detection,
        certainty: 'confirmed',
        object_policy_phase: policyPhase
      },
      policyPhase === 'maintain' ? { phase: 'maintain' } : {}
    );

    if (!existing) {
      const confirmed = policy.confirmationFrames <= 1 && eligible.allowed;
      objectTemporalTracks.set(trackKey, {
        canonical: resolved.canonical,
        count: 1,
        missedFrames: 0,
        lastSeenAt: now,
        bbox: detection.bbox,
        confirmed,
        policy,
        lastDetection: { ...detection }
      });
      matchedTrackKeys.add(trackKey);
      return {
        ...detection,
        certainty: confirmed ? 'confirmed' : 'uncertain',
        object_track_id: trackKey,
        object_track_class: resolved.canonical,
        object_policy_max_boxes: policy.maxBoxes,
        object_policy_min_confidence: policy.initialMinConfidence,
        object_policy_phase: 'initial',
        object_track_count: 1,
        object_track_iou: null,
        object_policy_reason: eligible.reason
      };
    }

    existing.count += 1;
    existing.missedFrames = 0;
    existing.lastSeenAt = now;
    existing.bbox = detection.bbox;
    existing.policy = policy;
    existing.confirmed = existing.count >= policy.confirmationFrames && eligible.allowed;
    existing.lastDetection = { ...detection };
    matchedTrackKeys.add(trackKey);
    return {
      ...detection,
      certainty: existing.confirmed ? 'confirmed' : 'uncertain',
      object_track_id: trackKey,
      object_track_class: resolved.canonical,
      object_policy_max_boxes: policy.maxBoxes,
      object_policy_min_confidence: policyPhase === 'maintain' ? policy.maintainMinConfidence : policy.initialMinConfidence,
      object_policy_phase: policyPhase,
      object_track_count: existing.count,
      object_track_iou: match.iou,
      object_policy_reason: eligible.reason
    };
  });

  for (const [key, track] of objectTemporalTracks.entries()) {
    if (!track.confirmed || matchedTrackKeys.has(key)) continue;
    const policy = track.policy || {};
    const missedFrames = Number(track.missedFrames || 0) + 1;
    const ageMs = now - Number(track.lastSeenAt || 0);
    if (missedFrames > Number(policy.maxMissedFrames || 0) || ageMs > Number(policy.maxMissedAgeMs || 0)) continue;
    track.missedFrames = missedFrames;
    const retained = {
      ...(track.lastDetection || {}),
      id: String((track.lastDetection && track.lastDetection.id) || key) + '-retained-' + String(missedFrames),
      certainty: 'confirmed',
      retained_track: true,
      object_track_id: key,
      object_track_class: track.canonical,
      object_policy_max_boxes: Number(policy.maxBoxes || 0) || undefined,
      object_policy_min_confidence: Number(policy.maintainMinConfidence || 0) || undefined,
      object_policy_phase: 'maintain',
      object_track_count: track.count,
      object_track_missed_frames: missedFrames,
      object_policy_reason: 'retained_confirmed_object_track'
    };
    annotated.push(retained);
  }

  return annotated;
}

function resetObjectTemporalTracks() {
  objectTemporalTracks.clear();
  objectTemporalTrackCounters.clear();
}

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
    confidenceThreshold: Number(detection.detection_min_confidence || detection.detection_confidence_threshold || 0.5),
    personCandidateConfidenceThreshold: Number(detection.person_min_confidence || detection.person_candidate_confidence_threshold || 0.30),
    faceConfidenceThreshold: Number(detection.face_min_confidence || detection.detection_min_confidence || detection.detection_confidence_threshold || 0.5),
    detectionIntervalFrames: Number(detection.detection_interval_frames || 5),
    detectionMinIntervalMs: Number(detection.detection_min_interval_ms || 500),
    maxAgeMs: Number(detection.detection_result_max_age_ms || detection.detection_max_age_ms || 5000),
    nmsIouThreshold: Number(detection.detection_nms_iou_threshold || 0.5),
    maxBoxesPerFrame: Number(detection.detection_max_boxes_per_frame || 50),
    maxBoxesPerClass: Number(detection.detection_max_boxes_per_class || 10),
    outOfOrderDropEnabled: detection.detection_out_of_order_drop_enabled !== false,
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
  if (frame.stream_session_id != null && typeof frame.stream_session_id !== 'string') return { valid: false, error: 'stream_session_id must be string if present' };
  if (frame.frame_sequence != null && (!Number.isFinite(Number(frame.frame_sequence)) || Number(frame.frame_sequence) < 0)) return { valid: false, error: 'frame_sequence must be non-negative number if present' };
  if (frame.result_sequence != null && (!Number.isFinite(Number(frame.result_sequence)) || Number(frame.result_sequence) < 0)) return { valid: false, error: 'result_sequence must be non-negative number if present' };
  if (!frame.captured_at) return { valid: false, error: 'captured_at is required' };
  if (!frame.detected_at) return { valid: false, error: 'detected_at is required' };
  if (frame.captured_at_ms != null && !Number.isFinite(Number(frame.captured_at_ms))) return { valid: false, error: 'captured_at_ms must be finite number if present' };
  if (frame.detected_at_ms != null && !Number.isFinite(Number(frame.detected_at_ms))) return { valid: false, error: 'detected_at_ms must be finite number if present' };
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
    const faceCandidate = label === 'face' || String(d.type || '').toLowerCase() === 'face';
    const conf = Number(d.confidence);
    if (!Number.isFinite(conf)) continue;
    
    const bbox = d.bbox;
    if (!bbox || !Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || 
        !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)) {
      continue;
    }

    const normalizedBox = {
      x: Math.max(0, Math.min(1, bbox.x)),
      y: Math.max(0, Math.min(1, bbox.y)),
      width: Math.max(0, Math.min(1, bbox.width)),
      height: Math.max(0, Math.min(1, bbox.height))
    };
    const candidate = {
      class_id: Number(d.class_id || 0),
      type: String(d.type || 'object'),
      label: String(d.label || d.type || 'object'),
      confidence: Math.max(0, Math.min(1, conf)),
      proposal_phrase: d.proposal_phrase ? String(d.proposal_phrase) : null,
      bbox: normalizedBox
    };
    const objectPolicy = personCandidate || faceCandidate
      ? null
      : objectClassForDetection(candidate).policy;
    const threshold = personCandidate
      ? config.personCandidateConfidenceThreshold
      : faceCandidate
        ? config.faceConfidenceThreshold
        : objectPolicy.initialMinConfidence;

    if (candidate.confidence < threshold) continue;
    if (objectPolicy) {
      const area = boxArea(normalizedBox);
      const aspect = boxAspectRatio(normalizedBox);
      if (
        area < objectPolicy.minArea ||
        area > objectPolicy.maxArea ||
        aspect < objectPolicy.minAspectRatio ||
        aspect > objectPolicy.maxAspectRatio
      ) {
        continue;
      }
    }

    detections.push({
      id: `yolo_${frameWidth}_${frameHeight}_${i}`,
      class_id: candidate.class_id,
      type: candidate.type,
      label: candidate.label,
      confidence: candidate.confidence,
      source: String(d.source || 'yolo'),
      proposal_phrase: candidate.proposal_phrase,
      proposal_sources: Array.isArray(d.proposal_sources)
        ? d.proposal_sources.map(String)
        : [String(d.source || 'yolo')],
      visual_fingerprint: d.visual_fingerprint
        ? String(d.visual_fingerprint)
        : null,
      bbox: normalizedBox
    });
  }
  
  return detections;
}

function parseYoloDetectionFrame(yoloResult, capturedAt, options = {}) {
  if (!yoloResult || typeof yoloResult !== 'object') {
    return { ok: false, marker: 'INVALID_YOLO_RESULT' };
  }
  
  const frameId = String(options.frame_id || yoloResult.frame_id || `frame_${Date.now()}_${Math.floor(Math.random() * 1000000)}`);
  const modelPath = getYoloModelPath();
  
  const rawDetections = normalizeYoloDetection(yoloResult, yoloResult.frame_width, yoloResult.frame_height);
  const capturedTs = capturedAt || yoloResult.captured_at || new Date().toISOString();
  const certaintyDetections = annotateDetectionCertainty(rawDetections, capturedTs);
  const config = getDetectionConfig();
  const objectPolicies = configuredObjectClassPolicy();
  const maxBoxesByClass = new Map();
  for (const [canonical, policy] of objectPolicies.policies.entries()) {
    maxBoxesByClass.set(canonical, policy.maxBoxes);
  }
  const suppressed = suppressDuplicateDetections(certaintyDetections, {
    iou_threshold: config.nmsIouThreshold,
    max_boxes_per_frame: config.maxBoxesPerFrame,
    max_boxes_per_class: config.maxBoxesPerClass,
    max_boxes_by_class: maxBoxesByClass,
    min_confidence: config.confidenceThreshold,
    person_min_confidence: config.personCandidateConfidenceThreshold,
    face_min_confidence: config.faceConfidenceThreshold
  });

  const now = new Date();
  const capturedAtMs = Date.parse(capturedTs) || now.getTime();
  
  return {
    ok: true,
    schema_version: 1,
    stream_session_id: options.stream_session_id || yoloResult.stream_session_id || null,
    frame_id: frameId,
    frame_sequence: Number(options.frame_sequence || yoloResult.frame_sequence || 0),
    result_sequence: Number(options.result_sequence || options.frame_sequence || yoloResult.result_sequence || yoloResult.frame_sequence || 0),
    captured_at: capturedTs || now.toISOString(),
    captured_at_ms: capturedAtMs,
    detected_at: now.toISOString(),
    detected_at_ms: now.getTime(),
    image_width: Number(yoloResult.frame_width || 1280),
    image_height: Number(yoloResult.frame_height || 720),
    source_width: Number(yoloResult.frame_width || 1280),
    source_height: Number(yoloResult.frame_height || 720),
    device: String(yoloResult.device || 'cpu'),
    model_source: String(yoloResult.model_source || modelPath),
    detections: suppressed.detections,
    dropped_detections: suppressed.dropped,
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
  annotateDetectionCertainty,
  resetObjectTemporalTracks,
  parseYoloDetectionFrame,
  storeDetectionResult,
  readLatestDetection,
  getDetectionStatus,
  validateDetection,
  validateDetectionFrame,
  processAlive
};
