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
const {
  PROJECT_ROOT: ROOT,
  getModelConfig,
  getPathConfig,
  getVisionConfig,
  getTimeoutConfig,
  getLiveChatConfig
} = require('../config/floki-config.cjs');
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
const {
  createInitialDetectionFrameState,
  reduceDetectionFrameState,
  splitDisplayDetections
} = require('./detection-frame-contract.cjs');

function readyTimeoutMs(options = {}) {
  if (options.timeout_ms) return Number(options.timeout_ms);
  const timeouts = getTimeoutConfig('chat');
  return Math.max(5000, Number(timeouts.model_warmup_ms));
}

const READY_TIMEOUT_MS = readyTimeoutMs();

function statusStaleMs() {
  const liveChat = getLiveChatConfig('chat');
  return Math.max(3000, 3 * Number(liveChat.runtime_heartbeat_ms || 1000));
}

function heartbeatMs() {
  const liveChat = getLiveChatConfig('chat');
  return Math.max(500, Number(liveChat.runtime_heartbeat_ms || 1000));
}

function maxPipeBufferBytes() {
  const vision = getVisionConfig('chat');
  const frames = Math.max(1, Math.min(120, Number(vision.frame_buffer_size || 120)));
  return Math.max(8 * 1024 * 1024, Math.min(256 * 1024 * 1024, frames * 1024 * 1024));
}

function assertNode24() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
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

function localHfVisionEndpoint(options = {}) {
  // The local HF vision endpoint is YAML-authoritative
  // (models.vision.local_endpoint); env overrides are for ops only, and there
  // is no hardcoded URL fallback in source.
  return options.local_endpoint ||
    options.hf_endpoint ||
    process.env.FLOKI_HF_COGNITION_ENDPOINT ||
    process.env.FLOKI_HF_VISION_ENDPOINT ||
    getModelConfig('chat').vision.local_endpoint;
}

function chatVisionTunnelConfig(options = {}) {
  const paths = runtimePaths(options);
  const visionModel = getModelConfig('chat').vision;
  const model = visionModel.model;
  const endpoint = localHfVisionEndpoint(options);
  const parsed = new URL(endpoint);

  return Object.freeze({
    enabled: true,
    active: true,
    local_only: true,
    web_host_only: true,
    target: undefined,
    local_host: parsed.hostname,
    local_port: Number(parsed.port),
    local_endpoint: endpoint,
    remote_host: null,
    remote_port: null,
    remote_endpoint: null,
    socket: path.join(paths.runtime_dir, 'chat-vision-local.sock'),
    required_model: model,
    model,
    provider: 'huggingface',
    backend: 'hf',
    check_timeout_ms: Number(options.check_timeout_ms || 8000)
  });
}

function readChatVisionTunnelStatus(options = {}) {
  const config = chatVisionTunnelConfig(options);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_LOCAL_HF_READY',
    active: true,
    local_only: true,
    web_host_only: true,
    target: undefined,
    local_endpoint: config.local_endpoint,
    remote_endpoint: null,
    socket: config.socket,
    required_model: config.required_model,
    model: config.model,
    provider: config.provider,
    backend: config.backend,
    chat_mode_only: true,
    game_mode_started: false
  });
}

async function verifyChatVisionTunnelModel(config) {
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_LOCAL_HF_MODEL_ASSUMED',
    local_only: true,
    web_host_only: true,
    required_model: config.required_model,
    model: config.model,
    provider: config.provider,
    backend: config.backend
  });
}

async function startChatVisionTunnel(options = {}) {
  const config = chatVisionTunnelConfig(options);
  ensureDirSync(runtimePaths(options).runtime_dir);
  const model = await verifyChatVisionTunnelModel(config);
  return Object.freeze({
    ...readChatVisionTunnelStatus(options),
    required_model_visible: true,
    model_check: model
  });
}

function stopChatVisionTunnel(options = {}) {
  const config = chatVisionTunnelConfig(options);
  fs.rmSync(config.socket, { force: true });
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_VISION_LOCAL_HF_STOPPED',
    local_only: true,
    web_host_only: true,
    target: undefined,
    local_endpoint: config.local_endpoint,
    remote_endpoint: null,
    socket: config.socket,
    was_active: true,
    required_model: config.required_model,
    model: config.model,
    provider: config.provider,
    backend: config.backend,
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
    '-vf',
    'scale=in_range=pc:out_range=pc,format=yuv420p',
    '-color_range',
    'pc',
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
  if (!status || typeof status !== 'object') return false;

  const baseReady = Boolean(
    status.service_process_alive === true &&
    status.ffmpeg_process_alive !== false &&
    status.camera_open === true &&
    status.first_frame_received !== false &&
    status.first_vlm_observation_succeeded === true &&
    status.last_fatal_error == null
  );
  if (!baseReady) return false;

  const detection = getDetectionConfig();

  // Frames must remain fresh (heartbeat written by the service process).
  if (status.heartbeat_fresh === false) return false;

  // Vision-language model readiness must block chat readiness when a status is present.
  // tunnel_status remains as a compatibility alias for the removed removed remote vision tunnel path.
  const modelStatus = status.vision_model_status || status.tunnel_status;
  if (modelStatus && modelStatus.active !== true) return false;

  // Strict readiness still requires a live detector heartbeat when detection is enabled.
  // UI camera liveness is reported separately through capture_live.
  if (detection.enabled === true && status.detection_heartbeat_fresh === false) return false;

  return true;
}

function captureLiveFromStatus(status) {
  if (!status || typeof status !== 'object') return false;
  return Boolean(
    status.service_process_alive === true &&
    status.ffmpeg_process_alive !== false &&
    status.camera_open === true &&
    status.first_frame_received !== false &&
    status.heartbeat_fresh !== false &&
    status.last_fatal_error == null
  );
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
    stream_session_id: state.stream_session_id || null,
    last_detection_frame_sequence: Number(state.last_detection_frame_sequence || 0),
    detection_in_flight: state.detection_in_flight === true,
    last_detection_started_at: state.last_detection_started_at || null,
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

function requireConfiguredVisionLanguageModel(models) {
  const visionModel = models.vision || {};
  const cognitionModel = models.cognition || {};
  const endpoint = String(
    visionModel.endpoint ||
    visionModel.local_endpoint ||
    cognitionModel.endpoint ||
    cognitionModel.local_endpoint ||
    ''
  ).replace(/\/+$/, '');
  const model = visionModel.model || cognitionModel.model || '';
  const keepAlive = visionModel.keep_alive || cognitionModel.keep_alive || null;
  const timeoutMs = Number(visionModel.timeout_ms || cognitionModel.timeout_ms || 0);

  if (!endpoint) throw new Error('vision language endpoint is missing from YAML model config');
  if (!model) throw new Error('vision language model is missing from YAML model config');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('vision language timeout_ms is missing from YAML model config');
  }

  return Object.freeze({
    endpoint,
    model,
    keep_alive: keepAlive,
    timeout_ms: timeoutMs,
    temperature: visionModel.temperature ?? cognitionModel.temperature,
    top_p: visionModel.top_p ?? cognitionModel.top_p,
    max_new_tokens: visionModel.generate_max_new_tokens ??
      visionModel.max_new_tokens ??
      cognitionModel.max_new_tokens ??
      cognitionModel.num_predict,
    num_predict: visionModel.num_predict ??
      visionModel.generate_num_predict ??
      cognitionModel.num_predict
  });
}

function buildConfiguredGenerationOptions(config) {
  const options = {};
  if (config.temperature !== undefined && config.temperature !== null) {
    options.temperature = Number(config.temperature);
  }
  if (config.top_p !== undefined && config.top_p !== null) {
    options.top_p = Number(config.top_p);
  }
  if (config.max_new_tokens !== undefined && config.max_new_tokens !== null) {
    options.max_new_tokens = Number(config.max_new_tokens);
  }
  if (config.num_predict !== undefined && config.num_predict !== null) {
    options.num_predict = Number(config.num_predict);
  }
  return options;
}


function sanitizeVisionObservationText(value) {
  let text = String(value || '').trim();
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();

  if (/^Thinking Process\s*:/i.test(text)) {
    const markerPattern = /(?:Final answer|Final response|Answer|Observation)\s*:\s*/ig;
    let match = null;
    let last = null;
    while ((match = markerPattern.exec(text)) !== null) {
      last = match;
    }
    if (!last) return '';
    text = text.slice(last.index + last[0].length).trim();
  }

  text = text.replace(/^\s*(?:Final answer|Final response|Answer|Observation)\s*:\s*/i, '').trim();
  if (/^(?:The user wants|I need to|Drafting the sentence|Analyze the Request)/i.test(text)) {
    return '';
  }
  return text;
}

async function callVisionModel(frameBuffer, options = {}) {
  const models = getModelConfig('chat');
  const runner = options.vlm_runner;
  if (typeof runner === 'function') {
    return runner(frameBuffer, options);
  }

  const config = requireConfiguredVisionLanguageModel(models);
  const timeoutSignal = AbortSignal.timeout(config.timeout_ms);
  const signal = options.abort_signal
    ? AbortSignal.any([timeoutSignal, options.abort_signal])
    : timeoutSignal;

  const frameBytes = Buffer.isBuffer(frameBuffer) ? frameBuffer.length : 0;
  if (frameBytes <= 0) {
    throw new Error('webcam VLM call refused: empty JPEG frame buffer');
  }

  const mimeType = typeof options.frame_mime_type === 'string' && options.frame_mime_type.trim()
    ? options.frame_mime_type.trim()
    : 'image/jpeg';
  const imageDataUrl = 'data:' + mimeType + ';base64,' + frameBuffer.toString('base64');

  const body = {
    model: config.model,
    stream: false,
    enable_thinking: false,
    strip_thinking: true,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: 'system',
        content: [
          'You are Floki-v2 local multimodal sight.',
          'Use the attached webcam image as the primary evidence.',
          'Write one concise external-world observation in natural first-person language.',
          'Mention only people, objects, spatial relations, text, and scene details visible in the image.',
          'Do not invent scene contents.',
          'Do not include private reasoning.',
          'Do not write a Thinking Process, analysis, draft notes, or scratchpad.',
          'Return only the final observation sentence.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: imageDataUrl
          },
          {
            type: 'text',
            text: 'Describe what is visible in this current webcam frame in one or two grounded sentences.'
          }
        ]
      }
    ],
    options: buildConfiguredGenerationOptions(config)
  };
  if (config.keep_alive) body.keep_alive = config.keep_alive;

  let response;
  try {
    response = await fetch(config.endpoint + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    const detail = error && error.cause && error.cause.message
      ? error.cause.message
      : (error && error.message ? error.message : String(error));
    throw new Error('vision language endpoint fetch failed for ' + config.endpoint + '/api/chat: ' + detail);
  }

  if (!response.ok) {
    throw new Error('vision language endpoint returned HTTP ' + String(response.status));
  }

  const json = await response.json();
  const rawContent = String(
    (json.message && json.message.content) ||
    json.response ||
    json.content ||
    ''
  ).trim();
  const content = sanitizeVisionObservationText(rawContent);

  if (!content) {
    throw new Error('vision language endpoint returned no final image-grounded observation');
  }

  return Object.freeze({
    observation_summary: content,
    raw_stats: Object.freeze({
      endpoint_status: response.status,
      direct_vlm_call: true,
      config_only_text_vision_bridge: false,
      image_sent_to_language_model: true,
      image_content_type: mimeType,
      frame_bytes: frameBytes,
      thinking_stripped: content !== rawContent
    })
  });
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
  const staleMs = statusStaleMs();
  const fresh = processAlive &&
    Number.isFinite(heartbeatAt) &&
    Date.now() - heartbeatAt <= staleMs;

  const detectionConfig = getDetectionConfig();
  const detectionHeartbeat = safeReadJson(path.join(paths.runtime_dir, 'yolo-detection.heartbeat.json'));
  const detectionHeartbeatAt = detectionHeartbeat && detectionHeartbeat.service_heartbeat
    ? new Date(detectionHeartbeat.service_heartbeat).getTime()
    : NaN;
  const detectionHeartbeatFresh = detectionConfig.enabled !== true ||
    (Number.isFinite(detectionHeartbeatAt) &&
      Date.now() - detectionHeartbeatAt <= Math.max(1000, Number(detectionConfig.maxAgeMs || 5000)));

  const baseStatus = Object.freeze({
    ...(status || {}),
    active: processAlive && fresh,
    service_process_alive: processAlive && fresh,
    heartbeat_fresh: fresh,
    detection_heartbeat_fresh: detectionHeartbeatFresh,
  });
  const enrichedStatus = Object.freeze({
    ...baseStatus,
    capture_live: captureLiveFromStatus(baseStatus),
    detection_live: detectionHeartbeatFresh,
    scene_live: captureLiveFromStatus(baseStatus) && baseStatus.first_vlm_observation_succeeded === true,
    pid,
    heartbeat_file: paths.heartbeat_file,
    status_file: paths.status_file,
    latest_private_observation_file: status && status.latest_private_observation_file
      ? status.latest_private_observation_file
      : paths.latest_observation_file,
    tunnel_status: tunnelStatus
  });

  return publicStatus(Object.freeze({
    ...enrichedStatus,
    ready_for_chat: statusReadyForChat(enrichedStatus)
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
  const vision = getVisionConfig('chat');
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
    ? splitDisplayDetections(latest.detection, {
        now_ms: Date.now(),
        max_age_ms: getDetectionConfig().maxAgeMs
      })
    : null;
  const visibleEntries = [
    ...((visible && visible.persons || []).map((detection) => ({ bucket: 'persons', detection }))),
    ...((visible && visible.objects || []).map((detection) => ({ bucket: 'objects', detection })))
  ];

  const personCount = visibleEntries.filter((entry) => entry.bucket === 'persons').length;
  const confirmedObjectCounts = new Map();
  const uncertainObjectLabels = new Set();

  for (const entry of visibleEntries) {
    if (entry.bucket !== 'objects') continue;
    const label = normalizedDetectionLabel(entry.detection);
    if (!label) continue;
    if (entry.detection.certainty === 'uncertain') {
      uncertainObjectLabels.add(label);
    } else {
      confirmedObjectCounts.set(label, Number(confirmedObjectCounts.get(label) || 0) + 1);
    }
  }

  // Labels that are already confirmed are not also flagged as uncertain.
  for (const label of uncertainObjectLabels) {
    if (confirmedObjectCounts.has(label)) uncertainObjectLabels.delete(label);
  }

  const maxObjects = Math.max(1, Number(vision.cognition_scene_max_detected_objects));
  const detectedObjects = Array.from(confirmedObjectCounts.entries())
    .map(([label, count]) => Object.freeze({ label, count }))
    .slice(0, maxObjects);

  const uncertainObjects = Array.from(uncertainObjectLabels)
    .map((label) => Object.freeze({ label }))
    .slice(0, maxObjects);

  if (personCount === 0 && detectedObjects.length === 0 && uncertainObjects.length === 0) return null;

  const facts = [];
  if (personCount > 0) facts.push(String(personCount) + (personCount === 1 ? ' person is visible' : ' people are visible'));
  if (detectedObjects.length > 0) {
    facts.push('visible objects include ' + detectedObjects.map((entry) => entry.count > 1 ? String(entry.count) + ' ' + entry.label : entry.label).join(', '));
  }

  const uncertainFacts = [];
  if (uncertainObjects.length > 0) {
    uncertainFacts.push('possible but unverified: ' + uncertainObjects.map((e) => e.label).join(', '));
  }

  const allFacts = [...facts, ...uncertainFacts];
  const timestamp = latest.detection.stored_at || latest.detection.detected_at || nowIso();
  return Object.freeze({
    available: true,
    fresh: true,
    stale: false,
    observation_age_ms: Number(latest.age_ms || 0),
    latest_private_observation_timestamp: timestamp,
    source: 'webcam_live_detection',
    sight_scope: 'maker_world_external',
    observation_summary: allFacts.join('. ') + (allFacts.length > 0 ? '.' : ''),
    scene_summary: null,
    detected_people_count: personCount,
    detected_objects: Object.freeze(detectedObjects),
    uncertain_objects: Object.freeze(uncertainObjects),
    grounding_summary: allFacts.join('. ') + (allFacts.length > 0 ? '.' : ''),
    detection_grounding_used: true,
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
  const detection = buildFreshDetectionObservation(options);
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
    scene_summary: null,
    detected_people_count: 0,
    detected_objects: Object.freeze([]),
    grounding_summary: null,
    unavailable_reason: reason,
    public_transcript_visible: false,
    chat_mode_only: true,
    game_mode_started: false
  });

  if (!observation || observation.ok !== true) {
    return detection || unavailable('missing_observation');
  }

  const sceneSummary = typeof observation.observation_summary === 'string'
    ? observation.observation_summary.trim()
    : '';
  if (!sceneSummary) {
    return detection || unavailable('empty_observation', { timestamp: observation.created_at || null });
  }

  const timestampMs = new Date(observation.created_at || '').getTime();
  if (!Number.isFinite(timestampMs)) {
    return detection || unavailable('invalid_observation_timestamp', { timestamp: observation.created_at || null });
  }

  const nowMs = Number(options.now_ms === undefined ? Date.now() : options.now_ms);
  const maxAgeMs = Math.max(1, Number(options.max_age_ms === undefined ? vision.latest_observation_max_age_ms : options.max_age_ms));
  const ageMs = Math.max(0, nowMs - timestampMs);
  if (ageMs > maxAgeMs) {
    return detection || unavailable('stale_observation', {
      timestamp: observation.created_at || null,
      observation_age_ms: ageMs
    });
  }

  const detectedObjects = detection && Array.isArray(detection.detected_objects)
    ? detection.detected_objects
    : [];
  const uncertainObjects = detection && Array.isArray(detection.uncertain_objects)
    ? detection.uncertain_objects
    : [];
  const people = detection ? Number(detection.detected_people_count || 0) : 0;
  const groundingSummary = detection && detection.grounding_summary
    ? detection.grounding_summary
    : null;

  return Object.freeze({
    available: true,
    fresh: true,
    stale: false,
    observation_age_ms: Math.min(ageMs, detection ? Number(detection.observation_age_ms || ageMs) : ageMs),
    latest_private_observation_timestamp: observation.created_at || null,
    source: detection ? 'fused_live_sight' : (observation.source || 'live_scene_perception'),
    sight_scope: observation.sight_scope || 'maker_world_external',
    observation_summary: sceneSummary,
    scene_summary: sceneSummary,
    detected_people_count: people,
    detected_objects: Object.freeze(detectedObjects),
    uncertain_objects: Object.freeze(uncertainObjects),
    grounding_summary: groundingSummary,
    detection_grounding_used: Boolean(detection),
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
  const timeoutMs = Number(options.timeout_ms || readyTimeoutMs(options));
  const started = Date.now();
  const signal = options.signal;
  while (Date.now() - started < timeoutMs) {
    if (signal && signal.aborted) {
      throw new Error('chat webcam vision readiness wait cancelled');
    }
    const status = readChatWebcamVisionStatus(options);
    if (status.ready_for_chat === true) return status;
    if (status.last_fatal_error) {
      throw new Error(status.last_fatal_error);
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('chat webcam vision readiness wait cancelled'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
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
    const ready = await waitForReady({ ...options, timeout_ms: options.timeout_ms || readyTimeoutMs(options) });
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
    stream_session_id: 'chat-webcam-' + String(process.pid) + '-' + String(Date.now()),
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
    detection_in_flight: false,
    last_detection_started_at: null,
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

  const heartbeat = setInterval(() => publish(), heartbeatMs());

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
    // Don't start detection while an inference is in flight either.
    if (state.first_vlm_observation_succeeded !== true) return;
    if (state.first_vlm_observation_succeeded === true && inFlightInference && vision.detection_continue_during_vlm !== true) return;

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
    state.detection_in_flight = true;
    state.last_detection_started_at = nowIso();
    lastDetectionStartedAtMs = nowMs;

    const detectionHeartbeatFile = path.join(paths.runtime_dir, 'yolo-detection.heartbeat.json');
    const heartbeatIntervalMs = Math.max(250, Number(detectionConfig.detection_heartbeat_interval_ms || 1000));
    const writeDetectionHeartbeat = (phase) => {
      writeJsonFileAtomicSync(detectionHeartbeatFile, {
        service_heartbeat: nowIso(),
        phase,
        detection_in_flight: state.detection_in_flight === true,
        last_detection_started_at: state.last_detection_started_at,
        last_detection_stored_at: state.last_detection_stored_at || null
      });
    };
    writeDetectionHeartbeat('running');
    const detectionHeartbeatTimer = setInterval(() => writeDetectionHeartbeat('running'), heartbeatIntervalMs);

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
        capturedAt,
        {
          stream_session_id: state.stream_session_id,
          frame_id: 'webcam-' + String(state.stream_session_id) + '-' + String(frameSequence),
          frame_sequence: frameSequence,
          result_sequence: frameSequence
        }
      );
      const reducedFrame = reduceDetectionFrameState(
        createInitialDetectionFrameState({ session_id: state.stream_session_id }),
        parsedFrame,
        {
          now_ms: Date.now(),
          max_age_ms: detectionConfig.maxAgeMs,
          accept_new_session: true
        }
      ).state;
      const currentFrame = {
        ...parsedFrame,
        detections: reducedFrame.detections,
        dropped_detections: {
          ...(parsedFrame.dropped_detections || {}),
          invalid_at_frame_contract: reducedFrame.dropCounts.invalid,
          suppressed_at_frame_contract: reducedFrame.dropCounts.suppressed
        }
      };
      const validation = validateDetectionFrame(currentFrame);

      if (!validation.valid) {
        throw new Error(
          'hybrid detection frame invalid: ' +
          validation.error
        );
      }

      const displayFrame =
        attachCachedPersonVerifications(currentFrame);
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
            currentFrame,
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
      clearInterval(detectionHeartbeatTimer);
      fs.rmSync(detectionFramePath, { force: true });
      inFlightDetection = false;
      state.detection_in_flight = false;
      writeDetectionHeartbeat(state.last_yolo_error ? 'error' : 'idle');
      publish();
    }
  }

  ffmpeg.stdout.on('data', (chunk) => {
    const maxBufferBytes = maxPipeBufferBytes();
    pipeBuffer = Buffer.concat([pipeBuffer, chunk]);
    if (pipeBuffer.length > maxBufferBytes) {
      pipeBuffer = pipeBuffer.subarray(pipeBuffer.length - maxBufferBytes);
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
    const result = await stopChatWebcamVisionService();
    console.log(JSON.stringify(result, null, 2));
    if (result.ok !== true) process.exitCode = 1;
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
  captureLiveFromStatus,
  buildOperationalStatus,
  publicStatus,
  formatChatWebcamVisionLines,
  runtimePaths
};
