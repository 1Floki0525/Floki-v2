'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  ensureDirSync,
  readJsonFileSync,
  writeJsonFileAtomicSync,
  existsSync
} = require('../util/fs-safe.cjs');
const { PROJECT_ROOT: ROOT, getModelConfig, getPathConfig, getVisionConfig } = require('../config/floki-config.cjs');
const { assertPublicTranscriptText } = require('../chat/chat-transcript.cjs');
const { webcamCaptureConfig } = require('./webcam-capabilities.cjs');
const { ffmpegPixelFormat } = require('./webcam-eyes-stream.cjs');
const { getDetectionConfig, storeDetectionResult, readLatestDetection, validateDetectionFrame, parseYoloDetectionFrame } = require('./yolo-detection-service.cjs');
const { runHybridDetectionOnFrame, stopHybridDetectionWorkers } = require('./hybrid-detection-service.cjs');
const {
  attachCachedPersonVerifications,
  classifyVerifiedDetectionForDisplay,
  isPersonCandidate,
  verifyDetectionFramePersons
} = require('./person-presence-verifier.cjs');

const READY_TIMEOUT_MS = 30000;
const STATUS_STALE_MS = 5000;
const HEARTBEAT_MS = 1000;
const MAX_PIPE_BUFFER_BYTES = 16 * 1024 * 1024;

function assertNode24() {
  if (!process.version.startsWith('v24.')) {
    throw new Error('Node 24 required for chat webcam vision service, got ' + process.version);
  }
}

function runtimePaths(options = {}) {
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(ROOT, paths.chat_runtime_root);
  return Object.freeze({
    runtime_dir: runtimeDir,
    pid_file: options.pid_file || path.join(runtimeDir, 'chat-webcam-vision.pid'),
    status_file: options.status_file || path.join(runtimeDir, 'chat-webcam-vision.status.json'),
    heartbeat_file: options.heartbeat_file || path.join(runtimeDir, 'chat-webcam-vision.heartbeat.json'),
    latest_observation_file: options.latest_observation_file || path.join(runtimeDir, 'chat-webcam-vision.latest-observation.private.json'),
    latest_frame_file: options.latest_frame_file || path.join(runtimeDir, 'chat-webcam-vision.latest-frame.jpg'),
    detection_frame_file: options.detection_frame_file || path.join(runtimeDir, 'chat-webcam-vision.yolo-frame.jpg'),
    refresh_request_file: options.refresh_request_file || path.join(runtimeDir, 'chat-webcam-vision.refresh-request.json'),
    log_file: options.log_file || path.join(runtimeDir, 'chat-webcam-vision.log')
  });
}

function chatVisionTunnelConfig(options = {}) {
  const paths = runtimePaths(options);
  const vision = getVisionConfig('chat');
  const socket = options.tunnel_socket || path.join(paths.runtime_dir, vision.vlm_ssh_tunnel_socket_name);
  return Object.freeze({
    enabled: vision.vlm_ssh_tunnel_enabled === true,
    target: vision.vlm_ssh_tunnel_target,
    local_host: vision.vlm_ssh_tunnel_local_host,
    local_port: Number(vision.vlm_ssh_tunnel_local_port),
    local_endpoint: 'http://' + vision.vlm_ssh_tunnel_local_host + ':' + String(vision.vlm_ssh_tunnel_local_port),
    remote_host: vision.vlm_ssh_tunnel_remote_host,
    remote_port: Number(vision.vlm_ssh_tunnel_remote_port),
    remote_endpoint: 'http://' + vision.vlm_ssh_tunnel_remote_host + ':' + String(vision.vlm_ssh_tunnel_remote_port),
    socket,
    required_model: getModelConfig('chat').vision.model,
    check_timeout_ms: Number(vision.vlm_ssh_tunnel_check_timeout_ms)
  });
}

function readChatVisionTunnelStatus(options = {}) {
  const config = chatVisionTunnelConfig(options);
  if (!config.enabled) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_CHAT_VISION_TUNNEL_DISABLED',
      active: false,
      chat_mode_only: true,
      game_mode_started: false
    });
  }
  const check = spawnSync('ssh', ['-S', config.socket, '-O', 'check', config.target], {
    encoding: 'utf8'
  });
  const active = check.status === 0;
  return Object.freeze({
    ok: true,
    marker: active ? 'FLOKI_V2_CHAT_VISION_TUNNEL_ACTIVE' : 'FLOKI_V2_CHAT_VISION_TUNNEL_INACTIVE',
    active,
    target: config.target,
    local_endpoint: config.local_endpoint,
    remote_endpoint: config.remote_endpoint,
    socket: config.socket,
    required_model: config.required_model,
    chat_mode_only: true,
    game_mode_started: false
  });
}

async function verifyChatVisionTunnelModel(config) {
  const response = await fetch(config.local_endpoint + '/api/tags', {
    signal: AbortSignal.timeout(config.check_timeout_ms)
  });
  if (!response.ok) {
    throw new Error('chat vision tunnel model check returned HTTP ' + String(response.status));
  }
  const json = await response.json();
  const models = Array.isArray(json.models) ? json.models : [];
  const found = models.some((model) => model && (model.name === config.required_model || model.model === config.required_model));
  if (!found) {
    throw new Error(config.required_model + ' not visible through chat vision SSH tunnel');
  }
  return true;
}

async function startChatVisionTunnel(options = {}) {
  const paths = runtimePaths(options);
  const config = chatVisionTunnelConfig(options);
  if (!config.enabled) {
    return readChatVisionTunnelStatus(options);
  }
  ensureDirSync(paths.runtime_dir);
  let status = readChatVisionTunnelStatus(options);
  if (!status.active) {
    fs.rmSync(config.socket, { force: true });
    const forward = config.local_host + ':' + String(config.local_port) + ':' +
      config.remote_host + ':' + String(config.remote_port);
    const start = spawnSync('ssh', [
      '-o',
      'BatchMode=yes',
      '-S',
      config.socket,
      '-M',
      '-f',
      '-N',
      '-L',
      forward,
      config.target
    ], {
      encoding: 'utf8'
    });
    if (start.status !== 0) {
      throw new Error('could not start chat vision SSH tunnel: ' + String(start.stderr || start.stdout || '').trim());
    }
    status = readChatVisionTunnelStatus(options);
  }
  await verifyChatVisionTunnelModel(config);
  return Object.freeze({
    ...status,
    required_model_visible: true
  });
}

function stopChatVisionTunnel(options = {}) {
  const config = chatVisionTunnelConfig(options);
  if (!config.enabled) {
    return readChatVisionTunnelStatus(options);
  }
  const check = spawnSync('ssh', ['-S', config.socket, '-O', 'check', config.target], {
    encoding: 'utf8'
  });
  if (check.status === 0) {
    spawnSync('ssh', ['-S', config.socket, '-O', 'exit', config.target], {
      encoding: 'utf8'
    });
  }
  fs.rmSync(config.socket, { force: true });
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_TUNNEL_STOPPED',
    target: config.target,
    local_endpoint: config.local_endpoint,
    remote_endpoint: config.remote_endpoint,
    socket: config.socket,
    was_active: check.status === 0,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function processIsAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function readPid(filePath) {
  if (!existsSync(filePath)) return null;
  const value = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function discoverVisionProcessIds() {
  const serviceNeedle = path.resolve(__filename) + ' --service';
  const workerNeedle = path.join(
    ROOT,
    '.floki-tools',
    'yolo-config',
    'yolo-worker.py'
  );
  const dinoWorkerNeedle = path.join(
    ROOT,
    '.floki-tools',
    'grounding-dino',
    'grounding-dino-worker.py'
  );
  const processInfos = [];
  let entries = [];

  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;

    const pid = Number(entry.name);

    try {
      const cmdline = fs
        .readFileSync(path.join('/proc', entry.name, 'cmdline'))
        .toString('utf8')
        .replace(/\0/g, ' ')
        .trim();
      const stat = fs.readFileSync(
        path.join('/proc', entry.name, 'stat'),
        'utf8'
      );
      const commandClose = stat.lastIndexOf(')');
      const fields = commandClose >= 0
        ? stat.slice(commandClose + 2).trim().split(/\s+/)
        : [];
      const parentPid = Number(fields[1]);

      processInfos.push(Object.freeze({
        pid,
        parent_pid: Number.isInteger(parentPid) && parentPid > 0
          ? parentPid
          : null,
        cmdline
      }));
    } catch (_error) {
      // The process exited while /proc was being scanned.
    }
  }

  const targets = new Set();

  for (const processInfo of processInfos) {
    if (
      processInfo.cmdline.includes(serviceNeedle) ||
      processInfo.cmdline.includes(workerNeedle) ||
      processInfo.cmdline.includes(dinoWorkerNeedle)
    ) {
      targets.add(processInfo.pid);
    }
  }

  let addedDescendant = true;

  while (addedDescendant) {
    addedDescendant = false;

    for (const processInfo of processInfos) {
      if (
        processInfo.parent_pid !== null &&
        targets.has(processInfo.parent_pid) &&
        !targets.has(processInfo.pid)
      ) {
        targets.add(processInfo.pid);
        addedDescendant = true;
      }
    }
  }

  return Array.from(targets);
}

function safeReadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return readJsonFileSync(filePath);
  } catch (_error) {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function buildContinuousFfmpegArgs(captureInput) {
  const capture = captureInput || webcamCaptureConfig('chat');
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    String(capture.ffmpeg_loglevel),
    '-f',
    String(capture.ffmpeg_input_format),
    '-input_format',
    ffmpegPixelFormat(capture.preferred_pixel_format),
    '-framerate',
    String(capture.target_fps),
    '-video_size',
    String(capture.target_width) + 'x' + String(capture.target_height),
    '-i',
    String(capture.device),
    '-an',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-'
  ];
}

function extractJpegFrames(buffer) {
  const frames = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0) break;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      return Object.freeze({ frames, remaining: buffer.subarray(start) });
    }
    frames.push(buffer.subarray(start, end + 2));
    cursor = end + 2;
  }
  return Object.freeze({ frames, remaining: Buffer.alloc(0) });
}

function measuredFps(totalFrames, firstFrameAtMs, lastFrameAtMs) {
  if (!firstFrameAtMs || !lastFrameAtMs || lastFrameAtMs <= firstFrameAtMs || totalFrames < 2) return 0;
  return Number(((totalFrames - 1) * 1000 / (lastFrameAtMs - firstFrameAtMs)).toFixed(1));
}

function statusReadyForChat(status) {
  return Boolean(status &&
    status.service_process_alive === true &&
    status.ffmpeg_process_alive === true &&
    status.camera_open === true &&
    status.first_frame_received === true &&
    status.first_vlm_observation_succeeded === true &&
    status.last_fatal_error === null);
}

function buildOperationalStatus(state, extra = {}) {
  const measuredCaptureFps = measuredFps(
    Number(state.total_frames_received || 0),
    state.first_frame_at_ms,
    state.last_frame_at_ms
  );
  const targetFps = Number(state.target_capture_fps || 0);
  const status = Object.freeze({
    ok: extra.ok !== false,
    marker: extra.marker || 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STATUS',
    pid: process.pid,
    ffmpeg_pid: state.ffmpeg_pid || null,
    camera_device: state.camera_device,
    camera_open: state.camera_open === true,
    first_frame_received: state.first_frame_received === true,
    total_frames_received: Number(state.total_frames_received || 0),
    measured_capture_fps: measuredCaptureFps,
    target_capture_fps: targetFps,
    target_fps_met: measuredCaptureFps >= targetFps,
    last_frame_timestamp: state.last_frame_timestamp || null,
    last_vlm_inference_timestamp: state.last_vlm_inference_timestamp || null,
    last_yolo_inference_timestamp: state.last_yolo_inference_timestamp || null,
    last_detection_stored_at: state.last_detection_stored_at || null,
    last_detection_frame_sequence: Number(state.last_detection_frame_sequence || 0),
    detection_source: 'live_mjpeg_frame_buffer',
    detector_schedule: 'time_based_latest_live_frame',
    person_verifier_payload_mode: 'crop_only',
    last_yolo_error: state.last_yolo_error || null,
    last_person_verifier_error: state.last_person_verifier_error || null,
    consecutive_vlm_failures: Number(state.consecutive_vlm_failures || 0),
    last_vlm_error: extra.last_vlm_error === undefined
      ? (state.last_vlm_error || null)
      : extra.last_vlm_error,
    latest_private_observation_timestamp: state.latest_private_observation_timestamp || null,
    latest_private_observation_file: state.latest_private_observation_file || null,
    service_heartbeat: nowIso(),
    last_fatal_error: extra.last_fatal_error === undefined ? null : extra.last_fatal_error,
    service_process_alive: extra.service_process_alive === undefined ? true : extra.service_process_alive === true,
    ffmpeg_process_alive: extra.ffmpeg_process_alive === undefined
      ? state.ffmpeg_process_alive === true
      : extra.ffmpeg_process_alive === true,
    first_vlm_observation_succeeded: state.first_vlm_observation_succeeded === true,
    ready_for_chat: false,
    raw_frame_storage_enabled: false,
    public_transcript_visible: false,
    desktop_screenshot_run_now: false,
    desktop_automation_used_for_sight: false,
    host_screenshot_vision: false,
    chat_mode_only: true,
    game_mode_started: false
  });
  return Object.freeze({
    ...status,
    ready_for_chat: statusReadyForChat(status)
  });
}

function publicStatus(status) {
  if (!status) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_INACTIVE',
      active: false,
      ready_for_chat: false,
      chat_mode_only: true,
      game_mode_started: false
    });
  }
  const {
    observation_summary: _observationSummary,
    image_base64: _imageBase64,
    latest_frame_base64: _latestFrameBase64,
    ...rest
  } = status;
  return Object.freeze(rest);
}

async function callVisionModel(frameBuffer, options = {}) {
  const models = getModelConfig('chat');
  const runner = options.vlm_runner;
  if (typeof runner === 'function') {
    return runner(frameBuffer, options);
  }
  const timeoutSignal = AbortSignal.timeout(models.vision.timeout_ms);
  const signal = options.abort_signal
    ? AbortSignal.any([timeoutSignal, options.abort_signal])
    : timeoutSignal;
  const response = await fetch(models.vision.endpoint + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: models.vision.model,
      prompt: 'Describe only externally visible webcam facts for Floki chat mode in one short sentence. Do not include private reasoning.',
      images: [frameBuffer.toString('base64')],
      stream: false,
      options: {
        temperature: models.vision.temperature,
        top_p: models.vision.top_p
      },
      keep_alive: models.vision.keep_alive
    }),
    signal
  });
  if (!response.ok) {
    throw new Error('vision endpoint returned HTTP ' + String(response.status));
  }
  const json = await response.json();
  return Object.freeze({ observation_summary: String(json.response || '').trim() });
}

function isAbortError(error, signal) {
  return Boolean(
    (signal && signal.aborted) ||
    (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
  );
}

async function callVisionModelWithRetry(frameBuffer, options = {}) {
  const vision = getVisionConfig('chat');
  const maxAttempts = Math.max(1, Number(
    options.max_attempts || vision.vlm_inference_max_attempts
  ));
  const retryDelayMs = Math.max(0, Number(
    options.retry_delay_ms === undefined
      ? vision.vlm_inference_retry_delay_ms
      : options.retry_delay_ms
  ));
  const singleAttempt = options.single_attempt_runner || callVisionModel;
  const sleepFn = options.sleep_fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await singleAttempt(frameBuffer, options);
    } catch (error) {
      lastError = error;
      if (isAbortError(error, options.abort_signal)) throw error;
      if (attempt >= maxAttempts) break;
      await sleepFn(retryDelayMs);
      if (options.abort_signal && options.abort_signal.aborted) throw error;
    }
  }

  throw new Error('vision inference failed after ' + maxAttempts + ' attempts: ' +
    String(lastError && lastError.message ? lastError.message : lastError));
}

function writeLatestObservation(result, paths, state) {
  const text = assertPublicTranscriptText(
    String(result && (result.observation_summary || result.response || '')).trim(),
    'chat webcam vision service observation'
  );
  if (!text) throw new Error('vision model did not return an observation summary');
  const record = Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_PRIVATE_OBSERVATION',
    created_at: nowIso(),
    source: 'webcam',
    sight_scope: 'maker_world_external',
    observation_summary: text,
    public_transcript_visible: false,
    raw_frame_storage_enabled: false,
    chat_mode_only: true,
    game_mode_started: false
  });
  writeJsonFileAtomicSync(paths.latest_observation_file, record);
  state.latest_private_observation_timestamp = record.created_at;
  state.latest_private_observation_file = paths.latest_observation_file;
  state.first_vlm_observation_succeeded = true;
  return record;
}

function readChatWebcamVisionStatus(options = {}) {
  const paths = runtimePaths(options);
  const pid = readPid(paths.pid_file);
  const aliveCheck = options.process_is_alive || processIsAlive;
  const processAlive = pid !== null && aliveCheck(pid);
  const status = safeReadJson(paths.status_file);
  const heartbeat = safeReadJson(paths.heartbeat_file);
  const tunnelStatus = readChatVisionTunnelStatus(options);
  const heartbeatAt = heartbeat && heartbeat.service_heartbeat
    ? new Date(heartbeat.service_heartbeat).getTime()
    : NaN;
  const fresh = processAlive &&
    Number.isFinite(heartbeatAt) &&
    Date.now() - heartbeatAt <= STATUS_STALE_MS;
  return publicStatus(Object.freeze({
    ...(status || {}),
    active: processAlive && fresh,
    service_process_alive: processAlive,
    heartbeat_fresh: fresh,
    pid,
    heartbeat_file: paths.heartbeat_file,
    status_file: paths.status_file,
    latest_private_observation_file: status && status.latest_private_observation_file
      ? status.latest_private_observation_file
      : paths.latest_observation_file,
    tunnel_status: tunnelStatus,
    ready_for_chat: statusReadyForChat({
      ...(status || {}),
      service_process_alive: processAlive && fresh
    })
  }));
}

function normalizedDetectionLabel(detection) {
  return String(
    detection &&
    (detection.label || detection.class || detection.name) ||
    ''
  )
    .toLowerCase()
    .replace(/^an?\s+/, '')
    .trim();
}

function buildFreshDetectionObservation(options = {}) {
  const paths = runtimePaths(options);
  const latest = readLatestDetection({
    runtime_dir: paths.runtime_dir
  });

  if (
    latest.available !== true ||
    latest.fresh !== true ||
    !latest.detection ||
    !Array.isArray(latest.detection.detections)
  ) {
    return null;
  }

  const visible = latest.detection.detections
    .map((detection) =>
      classifyVerifiedDetectionForDisplay(detection)
    )
    .filter((entry) =>
      entry &&
      (entry.bucket === 'persons' || entry.bucket === 'objects')
    );

  const personCount = visible.filter(
    (entry) => entry.bucket === 'persons'
  ).length;
  const objectLabels = Array.from(new Set(
    visible
      .filter((entry) => entry.bucket === 'objects')
      .map((entry) => normalizedDetectionLabel(entry.detection))
      .filter(Boolean)
  )).slice(0, 12);

  if (personCount === 0 && objectLabels.length === 0) {
    return null;
  }

  const parts = [];
  if (personCount > 0) {
    parts.push(
      String(personCount) +
      (personCount === 1 ? ' person' : ' people')
    );
  }
  if (objectLabels.length > 0) {
    parts.push('objects including ' + objectLabels.join(', '));
  }

  const timestamp =
    latest.detection.stored_at ||
    latest.detection.detected_at ||
    nowIso();

  return Object.freeze({
    available: true,
    fresh: true,
    stale: false,
    observation_age_ms: Number(latest.age_ms || 0),
    latest_private_observation_timestamp: timestamp,
    source: 'webcam_live_detection',
    sight_scope: 'maker_world_external',
    observation_summary:
      'Current live detector view: ' + parts.join('; ') + '.',
    detection_fallback_used: true,
    unavailable_reason: null,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}


function readLatestPrivateObservation(options = {}) {
  const paths = runtimePaths(options);
  const vision = getVisionConfig('chat');
  const preferredDetection = options.prefer_detection === true
    ? buildFreshDetectionObservation(options)
    : null;
  if (preferredDetection) return preferredDetection;
  const observation = safeReadJson(paths.latest_observation_file);
  const unavailable = (reason, extra = {}) => Object.freeze({
    available: false,
    fresh: false,
    stale: reason === 'stale_observation',
    observation_age_ms: extra.observation_age_ms === undefined ? null : extra.observation_age_ms,
    latest_private_observation_timestamp: extra.timestamp || null,
    source: null,
    sight_scope: null,
    observation_summary: null,
    unavailable_reason: reason,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });

  if (!observation || observation.ok !== true) {
    return buildFreshDetectionObservation(options) ||
      unavailable('missing_observation');
  }

  const summary = typeof observation.observation_summary === 'string'
    ? observation.observation_summary.trim()
    : '';
  if (!summary) {
    return buildFreshDetectionObservation(options) ||
      unavailable('empty_observation', {
        timestamp: observation.created_at || null
      });
  }

  const timestampMs = new Date(observation.created_at || '').getTime();
  if (!Number.isFinite(timestampMs)) {
    return buildFreshDetectionObservation(options) ||
      unavailable('invalid_observation_timestamp', {
        timestamp: observation.created_at || null
      });
  }

  const nowMs = Number(options.now_ms === undefined ? Date.now() : options.now_ms);
  const maxAgeMs = Math.max(1, Number(
    options.max_age_ms === undefined
      ? vision.latest_observation_max_age_ms
      : options.max_age_ms
  ));
  const ageMs = Math.max(0, nowMs - timestampMs);
  if (ageMs > maxAgeMs) {
    return buildFreshDetectionObservation(options) ||
      unavailable('stale_observation', {
        timestamp: observation.created_at || null,
        observation_age_ms: ageMs
      });
  }

  return Object.freeze({
    available: true,
    fresh: true,
    stale: false,
    observation_age_ms: ageMs,
    latest_private_observation_timestamp: observation.created_at || null,
    source: observation.source || 'webcam',
    sight_scope: observation.sight_scope || 'maker_world_external',
    observation_summary: summary,
    unavailable_reason: null,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function writeStatus(paths, status) {
  ensureDirSync(paths.runtime_dir);
  writeJsonFileAtomicSync(paths.status_file, publicStatus(status));
  writeJsonFileAtomicSync(paths.heartbeat_file, {
    service_heartbeat: status.service_heartbeat,
    pid: process.pid,
    ffmpeg_pid: status.ffmpeg_pid || null,
    chat_mode_only: true,
    game_mode_started: false
  });
  return status;
}

async function waitForReady(options = {}) {
  const timeoutMs = Number(options.timeout_ms || READY_TIMEOUT_MS);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = readChatWebcamVisionStatus(options);
    if (status.ready_for_chat === true) return status;
    if (status.last_fatal_error) {
      throw new Error(status.last_fatal_error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('chat webcam vision did not become ready before timeout');
}

async function startChatWebcamVisionService(options = {}) {
  assertNode24();
  const paths = runtimePaths(options);
  ensureDirSync(paths.runtime_dir);
  const existing = readChatWebcamVisionStatus(options);
  const discovered = discoverVisionProcessIds();
  if (existing.active === true || existing.service_process_alive === true) {
    return Object.freeze({
      ...existing,
      active: existing.active === true,
      owner: false,
      duplicate_prevented: true,
      discovered_pids: discovered
    });
  }
  if (discovered.length > 0) {
    await stopChatWebcamVisionService({ ...options, stop_tunnel: false });
  }
  fs.rmSync(paths.status_file, { force: true });
  fs.rmSync(paths.heartbeat_file, { force: true });
  const tunnelStatus = await startChatVisionTunnel(options);
  const out = fs.openSync(paths.log_file, 'a');
  const err = fs.openSync(paths.log_file, 'a');
  const child = spawn(process.execPath, [__filename, '--service'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      FLOKI_ALLOW_WEBCAM_CAPTURE: '1',
      FLOKI_ALLOW_CHAT_VISION: '1'
    }
  });
  child.unref();
  try {
    const ready = await waitForReady({ ...options, timeout_ms: options.timeout_ms || READY_TIMEOUT_MS });
    return Object.freeze({ ...ready, tunnel_status: tunnelStatus, owner: true, duplicate_prevented: false });
  } catch (error) {
    await stopChatWebcamVisionService(options);
    throw error;
  }
}

async function stopChatWebcamVisionService(options = {}) {
  const paths = runtimePaths(options);
  const pid = readPid(paths.pid_file);
  const aliveCheck = options.process_is_alive || processIsAlive;
  const killProcess = options.kill_process || ((targetPid, signal) => process.kill(targetPid, signal));
  const discover = options.discover_process_ids || discoverVisionProcessIds;
  const targets = Array.from(new Set([
    ...(pid ? [pid] : []),
    ...discover()
  ])).filter((targetPid) => aliveCheck(targetPid));

  for (const targetPid of targets) {
    try { killProcess(targetPid, 'SIGTERM'); } catch (_error) { /* already stopped */ }
  }

  const deadline = Date.now() + Number(options.timeout_ms || 10000);
  while (Date.now() < deadline && targets.some((targetPid) => aliveCheck(targetPid))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const survivors = targets.filter((targetPid) => aliveCheck(targetPid));
  for (const targetPid of survivors) {
    try { killProcess(targetPid, 'SIGKILL'); } catch (_error) { /* already stopped */ }
  }
  if (survivors.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const stopped = targets.every((targetPid) => !aliveCheck(targetPid));
  fs.rmSync(paths.pid_file, { force: true });
  const tunnelStatus = options.stop_tunnel === false ? null : stopChatVisionTunnel(options);
  return Object.freeze({
    ok: stopped,
    marker: stopped ? 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STOPPED' : 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STOP_TIMEOUT',
    active: !stopped,
    pid,
    stopped_pids: targets,
    tunnel_status: tunnelStatus,
    chat_mode_only: true,
    game_mode_started: false
  });
}
async function runChatWebcamVisionService(options = {}) {
  assertNode24();
  const env = options.env || process.env;
  const vision = getVisionConfig('chat');
  if (env[vision.webcam_capture_allow_env] !== '1' || env[vision.chat_vision_allow_env] !== '1') {
    throw new Error('chat webcam vision service requires guarded chat webcam authorization');
  }
  const paths = runtimePaths(options);
  ensureDirSync(paths.runtime_dir);
  const existingPid = readPid(paths.pid_file);
  if (existingPid && existingPid !== process.pid && processIsAlive(existingPid)) {
    throw new Error('chat webcam vision service already active with pid ' + existingPid);
  }
  fs.writeFileSync(paths.pid_file, String(process.pid) + '\n');

  const capture = webcamCaptureConfig('chat');
  const state = {
    camera_device: capture.device,
    target_capture_fps: capture.target_fps,
    camera_open: false,
    first_frame_received: false,
    first_vlm_observation_succeeded: false,
    total_frames_received: 0,
    first_frame_at_ms: null,
    last_frame_at_ms: null,
    last_frame_timestamp: null,
    last_vlm_inference_timestamp: null,
    latest_private_observation_timestamp: null,
    latest_private_observation_file: paths.latest_observation_file,
    consecutive_vlm_failures: 0,
    last_vlm_error: null,
    last_yolo_inference_timestamp: null,
    last_detection_stored_at: null,
    last_detection_frame_sequence: 0,
    last_yolo_error: null,
    last_person_verifier_error: null,
    ffmpeg_pid: null,
    ffmpeg_process_alive: false
  };
  let stopping = false;
  let inFlightInference = false;
  let inFlightDetection = false;
  let lastDetectionStartedAtMs = 0;
  let inFlightPersonVerification = false;
  // Detector initialization must not block the first VLM observation or
  // chat.local readiness. Active person verification temporarily locks
  // scene inference later in maybeDetect().
  let sceneInferenceUnlocked = true;
  let inferenceAbortController = null;
  const detectionAbortController = new AbortController();
  let fatalError = null;
  let pipeBuffer = Buffer.alloc(0);
  let latestFrame = null;

  const publish = (extra = {}) => writeStatus(paths, buildOperationalStatus(state, extra));
  const ffmpeg = spawn(capture.ffmpeg_bin, buildContinuousFfmpegArgs(capture), {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  state.ffmpeg_pid = ffmpeg.pid;
  state.ffmpeg_process_alive = true;
  state.camera_open = true;
  publish({ marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STARTING' });

  const requestStop = () => {
    stopping = true;
    if (inferenceAbortController) {
      inferenceAbortController.abort();
    }
    detectionAbortController.abort();
    stopHybridDetectionWorkers();
    if (ffmpeg && ffmpeg.pid && state.ffmpeg_process_alive) {
      ffmpeg.kill('SIGTERM');
    }
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);

  const heartbeat = setInterval(() => publish(), HEARTBEAT_MS);

  async function maybeInfer(frame) {
    if (stopping) return;
    const nowMs = Date.now();
    const forcedRefresh = existsSync(paths.refresh_request_file);
    const minInterval = Number(
      vision.vlm_inference_min_interval_ms || 1000
    );
    const enoughTime =
      !state.last_vlm_inference_at_ms ||
      nowMs - state.last_vlm_inference_at_ms >= minInterval;
    const firstObservation =
      state.first_vlm_observation_succeeded !== true;
    const everyFrames = Number(
      vision.vlm_inference_every_n_frames || 40
    );
    const dueFrame =
      everyFrames > 0 &&
      state.total_frames_received % everyFrames === 0;
    const latestObservationMs = new Date(
      state.latest_private_observation_timestamp || ''
    ).getTime();
    const refreshIntervalMs = Math.max(
      minInterval,
      Number(
        vision.vlm_observation_refresh_interval_ms || 8000
      )
    );
    const refreshDue =
      firstObservation ||
      !Number.isFinite(latestObservationMs) ||
      nowMs - latestObservationMs >= refreshIntervalMs;
    const inferenceDue =
      firstObservation ||
      forcedRefresh ||
      (enoughTime && (dueFrame || refreshDue));

    if (
      !sceneInferenceUnlocked ||
      inFlightInference ||
      inFlightPersonVerification ||
      !inferenceDue
    ) return;
    inFlightInference = true;
    if (forcedRefresh) fs.rmSync(paths.refresh_request_file, { force: true });
    inferenceAbortController = new AbortController();
    state.last_vlm_inference_at_ms = nowMs;
    state.last_vlm_inference_timestamp = nowIso();
    publish();
    try {
      const result = await callVisionModelWithRetry(frame, {
        ...options,
        abort_signal: inferenceAbortController.signal
      });
      if (stopping) return;
      state.consecutive_vlm_failures = 0;
      state.last_vlm_error = null;
      writeLatestObservation(result, paths, state);
      publish({ last_vlm_error: null });
    } catch (error) {
      if (stopping) return;
      if (
        isAbortError(
          error,
          inferenceAbortController &&
          inferenceAbortController.signal
        )
      ) {
        state.last_vlm_error = null;
        publish({ last_vlm_error: null });
        return;
      }
      state.consecutive_vlm_failures += 1;
      state.last_vlm_error = error.message;
      const maxConsecutiveFailures = Math.max(
        1,
        Number(vision.vlm_max_consecutive_failures)
      );
      const fatal = state.consecutive_vlm_failures >= maxConsecutiveFailures;

      if (fatal) {
        fatalError = error.message;
        publish({
          ok: false,
          marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_FATAL',
          last_vlm_error: state.last_vlm_error,
          last_fatal_error: fatalError
        });
        requestStop();
        process.exitCode = 1;
      } else {
        publish({
          ok: true,
          marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_DEGRADED',
          last_vlm_error: state.last_vlm_error,
          last_fatal_error: null
        });
      }
    } finally {
      inferenceAbortController = null;
      inFlightInference = false;
    }
  }

  async function maybeDetect(frame) {
    if (stopping || inFlightDetection) return;

    // Complete one real scene observation before starting detector workers.
    // Otherwise rapid person detections repeatedly abort the first VLM request
    // and chat.local can never satisfy ready_for_chat.
    if (state.first_vlm_observation_succeeded !== true) return;

    const detectionConfig = getDetectionConfig();
    if (detectionConfig.enabled !== true) return;

    const nowMs = Date.now();
    const minimumIntervalMs = Math.max(
      100,
      Number(
        detectionConfig.detectionMinIntervalMs ||
        detectionConfig.detection_min_interval_ms ||
        500
      )
    );

    if (
      lastDetectionStartedAtMs > 0 &&
      nowMs - lastDetectionStartedAtMs < minimumIntervalMs
    ) {
      return;
    }

    inFlightDetection = true;
    lastDetectionStartedAtMs = nowMs;

    const capturedAt = state.last_frame_timestamp || nowIso();
    const frameSequence = Number(state.total_frames_received || 0);
    const frameSnapshot = Buffer.from(frame);
    const detectionFramePath = path.join(
      paths.runtime_dir,
      'chat-webcam-vision.detect-' +
      String(process.pid) + '-' +
      String(frameSequence) + '.jpg'
    );

    state.last_yolo_inference_timestamp = capturedAt;
    state.last_detection_frame_sequence = frameSequence;
    publish();

    try {
      fs.writeFileSync(detectionFramePath, frameSnapshot);

      const hybridResult =
        await runHybridDetectionOnFrame(detectionFramePath);

      if (stopping) return;

      if (!hybridResult || hybridResult.ok !== true) {
        throw new Error(
          String(
            hybridResult &&
            (
              hybridResult.error ||
              hybridResult.marker
            ) ||
            'hybrid detection failed'
          )
        );
      }

      if (!Array.isArray(hybridResult.detections)) {
        throw new Error(
          'hybrid result did not contain a detections array'
        );
      }

      const parsedFrame = parseYoloDetectionFrame(
        hybridResult,
        capturedAt
      );
      const validation = validateDetectionFrame(parsedFrame);

      if (!validation.valid) {
        throw new Error(
          'hybrid detection frame invalid: ' +
          validation.error
        );
      }

      const displayFrame =
        attachCachedPersonVerifications(parsedFrame);
      const stored = storeDetectionResult(
        displayFrame,
        { runtime_dir: paths.runtime_dir }
      );

      if (!stored.ok) {
        throw new Error(stored.error || stored.marker);
      }

      state.last_yolo_error = null;
      state.last_detection_stored_at = nowIso();
      publish();

      const needsPersonVerification =
        displayFrame.detections.some(
          (detection) =>
            isPersonCandidate(detection) &&
            Array.isArray(detection.proposal_sources) &&
            detection.proposal_sources.includes('yolo') &&
            !(
              detection.verification &&
              detection.verification.verifier_ok === true
            )
        );

      if (!needsPersonVerification) {
        sceneInferenceUnlocked = true;
        return;
      }

      if (inFlightPersonVerification) return;

      const latestObservationMs = new Date(
        state.latest_private_observation_timestamp || ''
      ).getTime();
      const refreshIntervalMs = Math.max(
        Number(vision.vlm_inference_min_interval_ms || 1000),
        Number(
          vision.vlm_observation_refresh_interval_ms || 8000
        )
      );
      const sceneRefreshDue =
        !Number.isFinite(latestObservationMs) ||
        Date.now() - latestObservationMs >= refreshIntervalMs;

      // Never abort a scene observation for person verification. If a scene
      // refresh is due, consensus person boxes remain visible and verification
      // waits for a later detector frame.
      if (inFlightInference || sceneRefreshDue) {
        sceneInferenceUnlocked = true;
        return;
      }

      sceneInferenceUnlocked = false;
      inFlightPersonVerification = true;

      Promise.resolve()
        .then(async () => {
          while (inFlightInference && !stopping) {
            await new Promise((resolve) =>
              setTimeout(resolve, 50)
            );
          }

          if (stopping) return null;

          return verifyDetectionFramePersons(
            parsedFrame,
            detectionFramePath,
            {
              runtime_dir: paths.runtime_dir,
              full_frame_buffer: frameSnapshot,
              abort_signal:
                detectionAbortController.signal
            }
          );
        })
        .then((verifiedFrame) => {
          if (stopping || !verifiedFrame) return;

          const failed = Array.isArray(
            verifiedFrame.detections
          )
            ? verifiedFrame.detections.find(
                (detection) =>
                  detection.verification &&
                  detection.verification.verifier_ok === false &&
                  detection.verification.short_basis &&
                  !String(
                    detection.verification.short_basis
                  ).includes(
                    'strict verifier selection policy'
                  )
              )
            : null;

          state.last_person_verifier_error = failed
            ? String(
                failed.verification.short_basis ||
                'person verifier failed'
              )
            : (
                verifiedFrame.person_verification &&
                verifiedFrame.person_verification.error
                  ? String(
                      verifiedFrame.person_verification.error
                    )
                  : null
              );

          const current = readLatestDetection({
            runtime_dir: paths.runtime_dir
          });

          if (
            current.available === true &&
            current.detection
          ) {
            const currentVerified =
              attachCachedPersonVerifications(
                current.detection
              );

            const verifiedStored = storeDetectionResult(
              currentVerified,
              { runtime_dir: paths.runtime_dir }
            );

            if (!verifiedStored.ok) {
              throw new Error(
                verifiedStored.error ||
                verifiedStored.marker
              );
            }

            state.last_detection_stored_at = nowIso();
          }

          publish();
        })
        .catch((error) => {
          if (!stopping) {
            state.last_person_verifier_error = String(
              error && error.message
                ? error.message
                : error
            );
            publish({
              marker:
                'FLOKI_V2_CHAT_WEBCAM_SERVICE_DEGRADED'
            });
          }
        })
        .finally(() => {
          inFlightPersonVerification = false;
          sceneInferenceUnlocked = true;
        });
    } catch (error) {
      if (!stopping) {
        state.last_yolo_error = String(
          error && error.message
            ? error.message
            : error
        );
        sceneInferenceUnlocked = true;
        publish({
          marker:
            'FLOKI_V2_CHAT_WEBCAM_SERVICE_DEGRADED'
        });
      }
    } finally {
      fs.rmSync(detectionFramePath, { force: true });
      inFlightDetection = false;
    }
  }

  ffmpeg.stdout.on('data', (chunk) => {
    pipeBuffer = Buffer.concat([pipeBuffer, chunk]);
    if (pipeBuffer.length > MAX_PIPE_BUFFER_BYTES) {
      pipeBuffer = pipeBuffer.subarray(pipeBuffer.length - MAX_PIPE_BUFFER_BYTES);
    }
    const parsed = extractJpegFrames(pipeBuffer);
    pipeBuffer = parsed.remaining;
    for (const frame of parsed.frames) {
      latestFrame = Buffer.from(frame);
      state.total_frames_received += 1;
      const nowMs = Date.now();
      if (!state.first_frame_at_ms) state.first_frame_at_ms = nowMs;
      state.last_frame_at_ms = nowMs;
      state.last_frame_timestamp = nowIso();
      state.first_frame_received = true;
      try { fs.writeFileSync(paths.latest_frame_file, latestFrame); } catch (_e) { /* best-effort frame file write */ }
      if (!stopping) {
        // Scene inference gets first access to each startup frame. Detection is
        // enabled immediately after the first real VLM observation succeeds.
        maybeInfer(latestFrame);
        maybeDetect(latestFrame);
      }
    }
    publish();
  });

  ffmpeg.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) {
      fs.appendFileSync(paths.log_file, text.slice(-2000) + '\n');
    }
  });

  await new Promise((resolve, reject) => {
    ffmpeg.on('error', (error) => {
      publish({
        ok: false,
        marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_FATAL',
        last_fatal_error: error.message
      });
      reject(error);
    });
    ffmpeg.on('close', (code, signal) => {
      state.ffmpeg_process_alive = false;
      state.camera_open = false;
      clearInterval(heartbeat);
      if (!stopping) {
        const message = 'ffmpeg exited unexpectedly with code ' + String(code) + ' signal ' + String(signal || 'none');
        fatalError = message;
        publish({
          ok: false,
          marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_FATAL',
          last_fatal_error: fatalError
        });
        reject(new Error(message));
        return;
      }
      publish({
        ok: fatalError === null,
        marker: fatalError === null
          ? 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STOPPED'
          : 'FLOKI_V2_CHAT_WEBCAM_SERVICE_FATAL',
        last_fatal_error: fatalError,
        service_process_alive: false,
        ffmpeg_process_alive: false
      });
      resolve();
    });
  }).finally(() => {
    stopHybridDetectionWorkers();
    fs.rmSync(paths.detection_frame_file, { force: true });
    process.removeListener('SIGTERM', requestStop);
    process.removeListener('SIGINT', requestStop);
    const currentPid = readPid(paths.pid_file);
    if (currentPid === process.pid) fs.rmSync(paths.pid_file, { force: true });
  });
}

function formatChatWebcamVisionLines(status) {
  return [
    'Webcam vision: ' + (status.ready_for_chat ? 'ACTIVE' : 'INACTIVE'),
    'Webcam device: ' + (status.camera_device || 'unknown'),
    'Camera frames: ' + (status.first_frame_received ? 'flowing' : 'not flowing'),
    'Measured capture FPS: ' + String(status.measured_capture_fps ?? 'unknown'),
    'Target capture FPS: ' + String(status.target_capture_fps ?? 'unknown'),
    'Target FPS met: ' + String(status.target_fps_met === true),
    'Latest visual observation: ' + (status.latest_private_observation_timestamp || 'none')
  ];
}

async function main() {
  if (process.argv.includes('--service')) {
    await runChatWebcamVisionService();
    return;
  }
  if (process.argv.includes('--start')) {
    console.log(JSON.stringify(await startChatWebcamVisionService(), null, 2));
    return;
  }
  if (process.argv.includes('--stop')) {
    console.log(JSON.stringify(await stopChatWebcamVisionService(), null, 2));
    return;
  }
  console.log(JSON.stringify(readChatWebcamVisionStatus(), null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL',
      error: error.message,
      chat_mode_only: true,
      game_mode_started: false
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  READY_TIMEOUT_MS,
  assertNode24,
  runtimePaths,
  processIsAlive,
  discoverVisionProcessIds,
  readChatWebcamVisionStatus,
  readLatestPrivateObservation,
  callVisionModel,
  callVisionModelWithRetry,
  chatVisionTunnelConfig,
  readChatVisionTunnelStatus,
  startChatVisionTunnel,
  stopChatVisionTunnel,
  startChatWebcamVisionService,
  stopChatWebcamVisionService,
  runChatWebcamVisionService,
  buildContinuousFfmpegArgs,
  extractJpegFrames,
  measuredFps,
  statusReadyForChat,
  buildOperationalStatus,
  publicStatus,
  formatChatWebcamVisionLines,
  runtimePaths
};
