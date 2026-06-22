'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');

if (
  process.platform === 'linux' &&
  process.env.FLOKI_ELECTRON_ENABLE_GPU_SANDBOX !== '1'
) {
  // Electron/Chromium on the supported Linux NVIDIA/X11 host cannot load
  // Mesa's GBM helper inside the GPU sandbox. Keep hardware acceleration
  // enabled while disabling only Chromium's GPU-process sandbox.
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');

const { readChatTranscriptTail } = require(path.join(PROJECT_ROOT, 'src/chat/chat-transcript.cjs'));
const { buildFlokiLifecycleStatus } = require(path.join(PROJECT_ROOT, 'src/chat/floki-lifecycle-status.cjs'));
const { readChatWebcamVisionStatus, readLatestPrivateObservation, runtimePaths } = require(path.join(PROJECT_ROOT, 'src/vision/chat-webcam-vision-service.cjs'));
const { buildVisionStatus } = require(path.join(PROJECT_ROOT, 'src/vision/vision-status.cjs'));
const { loadAffectState } = require(path.join(PROJECT_ROOT, 'brain/emotions_base/index.cjs'));
const { getModelConfig, getPathConfig, getVisionConfig, getLiveChatConfig } = require(path.join(PROJECT_ROOT, 'src/config/floki-config.cjs'));
const { getDetectionConfig, readLatestDetection } = require(path.join(PROJECT_ROOT, 'src/vision/yolo-detection-service.cjs'));
const { classifyVerifiedDetectionForDisplay } = require(path.join(PROJECT_ROOT, 'src/vision/person-presence-verifier.cjs'));

let mainWindow = null;
let requestInFlight = false;
let lastRecordedAffectSignature = '';
const startedAt = Date.now();
const AFFECT_HISTORY_MAX = 360;
const VISION_TRACK_TTL_MS = 2500;
const visionDisplayTracks = {
  objects: [],
  persons: [],
};

function detectionBox(detection) {
  const box = detection && detection.bbox || {};
  return {
    x: Number(box.x || 0),
    y: Number(box.y || 0),
    width: Number(box.width || 0),
    height: Number(box.height || 0),
  };
}

function detectionIou(leftDetection, rightDetection) {
  const left = detectionBox(leftDetection);
  const right = detectionBox(rightDetection);
  const leftRight = left.x + left.width;
  const leftBottom = left.y + left.height;
  const rightRight = right.x + right.width;
  const rightBottom = right.y + right.height;
  const width = Math.max(
    0,
    Math.min(leftRight, rightRight) -
      Math.max(left.x, right.x)
  );
  const height = Math.max(
    0,
    Math.min(leftBottom, rightBottom) -
      Math.max(left.y, right.y)
  );
  const intersection = width * height;
  const union =
    left.width * left.height +
    right.width * right.height -
    intersection;
  return union > 0 ? intersection / union : 0;
}

function retainVisionDetections(kind, detections, now = Date.now()) {
  const tracks = visionDisplayTracks[kind];
  const incoming = Array.isArray(detections) ? detections : [];

  for (const detection of incoming) {
    const label = String(
      detection.label || detection.class || detection.name || kind
    ).toLowerCase();
    let bestTrack = null;
    let bestIou = 0;

    for (const track of tracks) {
      if (track.label !== label) continue;
      const overlap = detectionIou(track.detection, detection);
      if (overlap > bestIou) {
        bestIou = overlap;
        bestTrack = track;
      }
    }

    if (bestTrack && bestIou >= 0.20) {
      bestTrack.detection = detection;
      bestTrack.lastSeenAt = now;
    } else {
      tracks.push({
        label,
        detection,
        lastSeenAt: now,
      });
    }
  }

  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    if (now - tracks[index].lastSeenAt > VISION_TRACK_TTL_MS) {
      tracks.splice(index, 1);
    }
  }

  return tracks.map((track) => track.detection);
}

/* Electron is only a client. The launcher owns backend shutdown. */
function cleanupProcesses() {
  for (const response of mjpegClients) {
    try { response.end(); } catch (_error) { /* ignore */ }
  }
  mjpegClients.clear();
  if (mjpegServer) {
    try { mjpegServer.close(); } catch (_error) { /* ignore */ }
    mjpegServer = null;
    mjpegPort = 0;
  }
}

/* MJPEG streaming server — serves live video from vision service frame file */
let mjpegPort = 0;
let mjpegServer = null;
const MJPEG_BOUNDARY = '--jpgliveboundary--';
const mjpegClients = new Set();

const mjpegDiag = {
  startedAt: null,
  framesServed: 0,
  lastFrameServedAt: null,
  lastFrameSize: 0,
  clientConnectCount: 0,
  errors: 0,
  reconnects: 0,
};

function getMjpegDiag() {
  return { ...mjpegDiag, port: mjpegPort, connectedClients: mjpegClients.size };
}

function startMjpegServer(frameFile) {
  if (mjpegServer) {
    mjpegDiag.reconnects += 1;
    return Promise.resolve(mjpegPort);
  }
  return new Promise((resolve) => {
    mjpegDiag.startedAt = new Date().toISOString();
    mjpegServer = http.createServer((req, res) => {
      if (req.url !== '/live.mjpeg') {
        res.writeHead(404).end();
        return;
      }
      let lastMtime = 0;
      const client = { res, closed: false };
      mjpegDiag.clientConnectCount += 1;

      const listener = (curr) => {
        if (client.closed) return;
        try {
          if (curr.mtimeMs === lastMtime) return;
          lastMtime = curr.mtimeMs;
          const data = fs.readFileSync(frameFile);
          mjpegDiag.framesServed += 1;
          mjpegDiag.lastFrameServedAt = new Date().toISOString();
          mjpegDiag.lastFrameSize = data.length;
          res.write(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`);
          res.write(data);
          res.write('\r\n');
        } catch (_) { /* frame file not ready */ }
      };

      const onClientError = (err) => {
        mjpegDiag.errors += 1;
        client.closed = true;
        mjpegClients.delete(client);
        try { fs.unwatchFile(frameFile, listener); } catch (_) { /* ok */ }
      };

      req.on('close', () => {
        client.closed = true;
        mjpegClients.delete(client);
        try { fs.unwatchFile(frameFile, listener); } catch (_) { /* ok */ }
      });

      req.on('error', onClientError);
      res.on('error', onClientError);

      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'close',
      });

      mjpegClients.add(client);
      fs.watchFile(frameFile, { interval: 50 }, listener);
      try { listener(fs.statSync(frameFile)); } catch (_) { /* send initial on next frame */ }
    });

    mjpegServer.on('error', (err) => {
      mjpegDiag.errors += 1;
      console.error('[MJPEG] Server error:', err.message);
      mjpegServer = null;
      mjpegPort = 0;
    });

    mjpegServer.listen(0, '127.0.0.1', () => {
      mjpegPort = mjpegServer.address().port;
      console.error('[MJPEG] Server started on port', mjpegPort);
      resolve(mjpegPort);
    });
  });
}

const runtimeConfig = getLiveChatConfig('chat');
const RUNTIME_URL = 'http://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port);

async function runtimeRequest(method, pathname, body = null) {
  const response = await fetch(RUNTIME_URL + pathname, {
    method,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(130000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `runtime HTTP ${response.status}`);
  return payload;
}

function runtimeStatusFile() {
  const runtimeRoot = path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root);
  return path.join(runtimeRoot, 'chat-local-runtime.status.json');
}

function readRuntimeStatus() {
  return safeJson(runtimeStatusFile(), {
    ok: false,
    ready: false,
    state: 'offline',
    brain_loaded: false,
    memory_loaded: false,
    hearing: {},
  });
}

function safeJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return fallback; }
}

function readJsonl(file, limit = 250) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
    return lines.map((line) => { try { return JSON.parse(line); } catch (_error) { return null; } }).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (_error) { /* best-effort */ }
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (_error) { return false; }
}

function normalizeTranscript(entry) {
  return {
    id: entry.id || `${entry.created_at || Date.now()}-${entry.role || 'unknown'}`,
    role: entry.role === 'floki' ? 'assistant' : 'user',
    content: String(entry.text || ''),
    type: entry.input_modality === 'spoken' || entry.output_modality === 'spoken' ? 'spoken' : 'typed',
    timestamp: Date.parse(entry.created_at || entry.timestamp || '') || Date.now(),
    isStreaming: false,
    latency: null,
  };
}

function emotionState() {
  const state = loadAffectState({ persist_diagnostics: false });
  const core = state.core || {};
  const emotions = state.emotions || {};
  return {
    valence: Number(core.valence || 0),
    arousal: Number(core.arousal || 0),
    trust: Number(emotions.trust || 0),
    curiosity: Number(emotions.curiosity || 0),
    hope: Number(emotions.hope || 0),
    fear: Number(emotions.fear || 0),
    frustration: Number(emotions.frustration || 0),
    attachment: Number(emotions.attachment || 0),
    confidence: Math.max(0, Math.min(1, (Number(core.dominance || 0) + 1) / 2)),
    uncertainty: Number(emotions.uncertainty || 0),
    mood: state.mood || null,
    timestamp: Date.parse(state.updated_at || '') || Date.now(),
  };
}

function recordAffectHistory() {
  const paths = getPathConfig('chat');
  const historyFile = path.resolve(PROJECT_ROOT, paths.chat_runtime_root, 'affect-history.jsonl');
  const current = emotionState();
  const sig = [current.valence, current.arousal, current.trust, current.curiosity, current.timestamp].join('|');
  if (sig === lastRecordedAffectSignature) return;
  lastRecordedAffectSignature = sig;
  appendJsonl(historyFile, current);
  const all = readJsonl(historyFile, AFFECT_HISTORY_MAX);
  if (all.length >= AFFECT_HISTORY_MAX) {
    try {
      const trimmed = all.slice(-Math.floor(AFFECT_HISTORY_MAX * 0.75));
      fs.writeFileSync(historyFile, trimmed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch (_error) { /* best-effort trim */ }
  }
}

function sleepStatus() {
  const status = buildFlokiLifecycleStatus();
  const affect = loadAffectState({ persist_diagnostics: false });
  const sleepPressure = Number(affect?.regulation?.sleep_pressure || 0);
  return {
    state: String(status.state || 'awake').replace(/(^|_)([a-z])/g, (_m, p, c) => `${p ? ' ' : ''}${c.toUpperCase()}`),
    alertness: Math.max(0, 1 - sleepPressure),
    sleepPressure,
    remActive: status.state === 'rem' || status.current_rem_cycle_number != null,
    currentRemCycle: Number(status.current_rem_cycle_number || 0),
    dreaming: status.state === 'dreaming' || status.state === 'rem',
    thinking: readRuntimeStatus().active_turn === true,
    speaking: readRuntimeStatus().hearing?.speaking === true,
    listening: readRuntimeStatus().hearing?.service_state === 'listening',
    externalEyesActive: readChatWebcamVisionStatus().ready_for_chat === true,
    currentMode: 'Chat Local',
    lastInteraction: Date.now(),
    sessionUptime: Date.now() - startedAt,
    raw: status,
  };
}

function visionFrame() {
  const service = readChatWebcamVisionStatus();
  const observation = readLatestPrivateObservation();
  const runtimeDir = path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root);

  const currentObjects = [];
  const currentPersons = [];
  const faces = [];
  const latestDetection = readLatestDetection({ runtime_dir: runtimeDir });
  const rawDetections = latestDetection.available === true && latestDetection.fresh === true && latestDetection.detection
    ? (Array.isArray(latestDetection.detection.detections) ? latestDetection.detection.detections : [])
    : [];
  for (const detection of rawDetections) {
    const disposition = classifyVerifiedDetectionForDisplay(detection);
    if (disposition.bucket === 'persons') {
      currentPersons.push(disposition.detection);
    }
    if (disposition.bucket === 'objects') {
      currentObjects.push(disposition.detection);
    }
  }

  const objects = retainVisionDetections(
    'objects',
    currentObjects
  );
  const persons = retainVisionDetections(
    'persons',
    currentPersons
  );

  const sceneAvailable = Boolean(
    observation &&
    observation.available === true &&
    observation.fresh === true &&
    typeof observation.observation_summary === 'string' &&
    observation.observation_summary.trim()
  );
  const cameraActive = service.active === true && service.camera_open === true;

  return {
    objects,
    persons,
    faces,
    scene: {
      available: sceneAvailable,
      label: sceneAvailable ? observation.observation_summary.trim() : '',
      confidence: null,
    },
    detection: {
      available: latestDetection.available === true,
      fresh: latestDetection.fresh === true,
      stale: latestDetection.stale === true,
      ageMs: latestDetection.age_ms,
      error: latestDetection.error || service.last_yolo_error || null,
      rawCount: rawDetections.length,
      objectCount: objects.length,
      personCount: persons.length,
    },
    timestamp: Date.now(),
    frameRate: Number(service.measured_capture_fps || 0),
    connectionStatus: cameraActive ? 'active' : 'offline',
    service,
    observation,
  };
}
function getLatestFrameBase64() {
  const paths = runtimePaths();
  const frameFile = paths.latest_frame_file;
  if (!fs.existsSync(frameFile)) return null;
  try {
    const data = fs.readFileSync(frameFile);
    return 'data:image/jpeg;base64,' + data.toString('base64');
  } catch (_error) {
    return null;
  }
}

function safeFileTime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (_error) {
    return Date.now();
  }
}

function readPidFile(filePath) {
  try {
    const value = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

function uptimeFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Math.max(0, Date.now() - Number(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || Date.now()));
  } catch (_error) {
    return 0;
  }
}

function serviceStatus() {
  const paths = getPathConfig('chat');
  const runtimeRoot = path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
  const stateRoot = path.resolve(PROJECT_ROOT, paths.state_root || 'state/floki');
  const webcam = readChatWebcamVisionStatus();
  const lifecycle = buildFlokiLifecycleStatus();

  const schedulerPidFile = path.join(runtimeRoot, 'sleep-cycle-scheduler.pid');
  const visionPidFile = path.join(runtimeRoot, 'chat-webcam-vision.pid');
  const hearingPidFile = path.join(runtimeRoot, 'chat-local-runtime.pid');
  const schedulerHeartbeat = path.join(runtimeRoot, 'sleep-cycle-scheduler.heartbeat.json');
  const visionHeartbeat = path.join(runtimeRoot, 'chat-webcam-vision.heartbeat.json');
  const hearingLog = path.join(runtimeRoot, 'chat-local-runtime.log');
  const runtimeStatus = readRuntimeStatus();

  const schedulerPid = readPidFile(schedulerPidFile);
  const visionPid = readPidFile(visionPidFile);
  const hearingPid = readPidFile(hearingPidFile);
  const schedulerRunning = processAlive(schedulerPid);
  const visionRunning = processAlive(visionPid);
  const hearingRunning = processAlive(hearingPid);
  const coreRunning = hearingRunning && runtimeStatus.brain_loaded === true;
  const runtimeSleeping = runtimeStatus.lifecycle?.is_awake === false || runtimeStatus.state === 'sleeping';
  const hearingError = runtimeStatus.hearing?.last_error || runtimeStatus.hearing?.last_wake_gate_error || runtimeStatus.hearing_start_error || null;
  const hearingReady = runtimeStatus.hearing_ready === true && !hearingError;
  const speechReady = !runtimeSleeping && runtimeStatus.hearing?.piper_ready === true && runtimeStatus.hearing?.playback_ready === true && !hearingError;

  let emotionHealthy = false;
  try {
    emotionHealthy = Boolean(loadAffectState({ persist_diagnostics: false }));
  } catch (_error) {
    emotionHealthy = false;
  }

  const memoryHealthy = runtimeStatus.memory_loaded === true && fs.existsSync(stateRoot);
  const nativeBridgeRunning = Boolean(mainWindow && !mainWindow.isDestroyed());
  const visionError = webcam.last_fatal_error || webcam.last_yolo_error || webcam.last_vlm_error || null;
  const visionStatus = webcam.ready_for_chat === true
    ? 'Running'
    : (webcam.active === true || visionRunning ? 'Degraded' : 'Stopped');
  const now = Date.now();

  return [
    {
      name: 'Floki Core',
      status: coreRunning ? 'Running' : 'Stopped',
      lastHeartbeat: Math.max(safeFileTime(hearingLog), safeFileTime(visionHeartbeat), safeFileTime(schedulerHeartbeat)),
      uptime: hearingRunning ? Number(runtimeStatus.uptime_ms || uptimeFromFile(hearingPidFile)) : 0,
      latency: 0,
      lastError: null,
      detail: coreRunning ? 'One backend-owned core brain serves typed and spoken chat.' : 'The authoritative chat.local brain runtime is offline.',
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartChat',
      logKey: 'Floki Core',
    },
    {
      name: 'Cognition',
      status: coreRunning ? 'Running' : 'Stopped',
      lastHeartbeat: now,
      uptime: coreRunning ? Number(runtimeStatus.uptime_ms || 0) : 0,
      latency: 0,
      lastError: null,
      detail: coreRunning ? `Configured model: ${getModelConfig('chat').cognition.model}; shared runtime session ${runtimeStatus.session_id || 'unknown'}.` : `Configured model: ${getModelConfig('chat').cognition.model}; runtime offline.`,
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartChat',
      logKey: 'Cognition',
    },
    {
      name: 'Vision',
      status: visionStatus,
      lastHeartbeat: safeFileTime(visionHeartbeat),
      uptime: uptimeFromFile(visionPidFile),
      latency: 0,
      lastError: visionError,
      detail: `Webcam ${webcam.camera_open === true ? 'open' : 'closed'} · ${Number(webcam.measured_capture_fps || 0).toFixed(1)} FPS · YOLO/VLM status reported separately by the vision service.`,
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartVision',
      logKey: 'Vision',
    },
    {
      name: 'Hearing',
      status: runtimeSleeping ? 'Stopped' : (hearingReady ? 'Running' : (hearingRunning ? 'Degraded' : 'Stopped')),
      lastHeartbeat: Date.parse(runtimeStatus.hearing?.last_heartbeat_at || '') || safeFileTime(hearingLog),
      uptime: uptimeFromFile(hearingPidFile),
      latency: 0,
      lastError: hearingError,
      detail: runtimeSleeping
        ? 'Hearing is intentionally suspended while Floki is asleep.'
        : hearingReady
          ? `Continuous microphone open · Silero ready · Whisper ready · wake gate healthy.`
          : `Continuous hearing is degraded${hearingError ? ': ' + hearingError : '.'}`,
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartHearing',
      logKey: 'Hearing',
    },
    {
      name: 'Speech',
      status: runtimeSleeping ? 'Stopped' : (speechReady ? 'Running' : (hearingRunning ? 'Degraded' : 'Stopped')),
      lastHeartbeat: Date.parse(runtimeStatus.hearing?.last_heartbeat_at || '') || safeFileTime(hearingLog),
      uptime: uptimeFromFile(hearingPidFile),
      latency: 0,
      lastError: hearingError,
      detail: runtimeSleeping
        ? 'Speech is inactive while Floki is asleep.'
        : speechReady
          ? `Piper ready · playback ready · speaking ${runtimeStatus.hearing?.speaking === true}.`
          : 'Speech service is not ready.',
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartSpeech',
      logKey: 'Speech',
    },
    {
      name: 'Memory',
      status: memoryHealthy ? 'Running' : 'Degraded',
      lastHeartbeat: safeFileTime(stateRoot),
      uptime: now - startedAt,
      latency: 0,
      lastError: memoryHealthy ? null : 'State root is unavailable',
      detail: 'Persistent state and memory files remain under the Floki-v2 state authority.',
      restartAvailable: false,
      logAvailable: true,
      controlAction: null,
      logKey: 'Memory',
    },
    {
      name: 'Emotion',
      status: emotionHealthy ? 'Running' : 'Degraded',
      lastHeartbeat: now,
      uptime: now - startedAt,
      latency: 0,
      lastError: emotionHealthy ? null : 'Affect state could not be loaded',
      detail: 'Persistent affect state is read directly from the Floki emotion module.',
      restartAvailable: false,
      logAvailable: true,
      controlAction: null,
      logKey: 'Emotion',
    },
    {
      name: 'Sleep Scheduler',
      status: schedulerRunning ? 'Running' : 'Stopped',
      lastHeartbeat: safeFileTime(schedulerHeartbeat),
      uptime: uptimeFromFile(schedulerPidFile),
      latency: 0,
      lastError: null,
      detail: lifecycle.sleep_cycle_scheduler_note || 'Sleep scheduler state unavailable.',
      restartAvailable: true,
      logAvailable: true,
      controlAction: 'restartScheduler',
      logKey: 'Sleep Scheduler',
    },
    {
      name: 'Dream Engine',
      status: schedulerRunning || lifecycle.is_dreaming ? 'Running' : 'Stopped',
      lastHeartbeat: Number(Date.parse(lifecycle.last_transition_at || '')) || now,
      uptime: schedulerRunning ? uptimeFromFile(schedulerPidFile) : 0,
      latency: 0,
      lastError: null,
      detail: lifecycle.is_dreaming ? 'REM dream generation is active.' : 'Dream engine is scheduled by the sleep-cycle runtime.',
      restartAvailable: false,
      logAvailable: true,
      controlAction: null,
      logKey: 'Dream Engine',
    },
    {
      name: 'Local API',
      status: runtimeStatus.api_ready === true ? 'Running' : 'Stopped',
      lastHeartbeat: now,
      uptime: now - startedAt,
      latency: 0,
      lastError: null,
      detail: runtimeStatus.api_ready === true ? `Authoritative local runtime API active at ${RUNTIME_URL}.` : 'Authoritative local runtime API is offline.',
      restartAvailable: false,
      logAvailable: true,
      controlAction: null,
      logKey: 'Local API',
    },
    {
      name: 'WebSocket Connection',
      status: nativeBridgeRunning ? 'Running' : 'Stopped',
      lastHeartbeat: now,
      uptime: now - startedAt,
      latency: 0,
      lastError: null,
      detail: 'Renderer events use the native IPC bridge; no fake WebSocket connection is claimed.',
      restartAvailable: false,
      logAvailable: true,
      controlAction: null,
      logKey: 'WebSocket Connection',
    },
    {
      name: 'Minecraft Bridge',
      status: 'Stopped',
      lastHeartbeat: now,
      uptime: 0,
      latency: 0,
      lastError: null,
      detail: 'Not loaded in chat.local. Minecraft game mode remains isolated and must not be started from this interface.',
      restartAvailable: false,
      logAvailable: false,
      controlAction: null,
      logKey: 'Minecraft Bridge',
    },
  ];
}

function neuralEvents(limit) {
  const paths = getPathConfig('chat');
  const candidates = [
    path.join(PROJECT_ROOT, 'state/floki/diagnostics.jsonl'),
    path.resolve(PROJECT_ROOT, paths.chat_runtime_root, 'latency-events.jsonl'),
  ];
  const all = [];
  for (const file of candidates) {
    for (const record of readJsonl(file, limit)) {
      const source = String(record.module || record.source || record.stage || 'system');
      all.push({
        id: record.id || record.event_id || `${source}-${record.created_at || record.timestamp || all.length}`,
        timestamp: Date.parse(record.created_at || record.timestamp || '') || Date.now(),
        module: source.charAt(0).toUpperCase() + source.slice(1),
        eventType: record.status || record.type || record.stage || 'event',
        summary: record.safe_summary || record.summary || record.message || record.status || JSON.stringify(record).slice(0, 280),
        severity: record.error || record.failure ? 'error' : 'info',
        traceId: record.trace_id || record.output_id || record.event_id || 'local',
        duration: Number(record.duration_ms || record.elapsed_ms || 0),
        privacyLevel: 'Safe Summary',
      });
    }
  }
  return all.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
}

function dreamTimeline() {
  const dreamFiles = [];
  const stateRoot = path.join(PROJECT_ROOT, 'state/floki');
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/dream|rem/i.test(entry.name) && /\.(json|jsonl)$/i.test(entry.name)) dreamFiles.push(full);
    }
  }
  walk(stateRoot);
  const fragments = [];
  for (const file of dreamFiles) {
    const records = file.endsWith('.jsonl') ? readJsonl(file, 500) : [safeJson(file)].flat().filter(Boolean);
    for (const record of records) {
      const item = record.fragment || record.dream || record;
      fragments.push({
        id: item.id || item.dream_id || `${path.basename(file)}-${fragments.length}`,
        timestamp: Date.parse(item.created_at || item.timestamp || '') || Date.now(),
        remCycleIndex: Number(item.rem_cycle_index || item.cycle_number || 0),
        cyclePhase: item.cycle_phase || item.state || 'Dream',
        duration: Number(item.duration_ms || item.duration || 0),
        memoryTags: Array.isArray(item.memory_tags) ? item.memory_tags : Array.isArray(item.tags) ? item.tags : [],
        visualElements: Array.isArray(item.visual_elements) ? item.visual_elements : [],
        emotionalTone: item.emotional_tone || { valence: Number(item.valence || 0), arousal: Number(item.arousal || 0) },
        narrative: item.safe_summary || item.narrative || item.summary || 'Dream record available without a public narrative.',
        intensity: Number(item.intensity || 0),
        isLucid: item.is_lucid === true,
        status: item.status || 'archived',
      });
    }
  }
  const sorted = fragments.sort((a, b) => a.timestamp - b.timestamp);
  const earliest = sorted.length > 0 ? sorted[0].timestamp : Date.now();
  const latest = sorted.length > 0 ? sorted[sorted.length - 1].timestamp : Date.now();
  return {
    fragments: sorted,
    cycles: [],
    sourceFiles: dreamFiles,
    sessionDate: new Date(earliest).toISOString(),
    totalSleepDuration: latest - earliest,
    totalFragments: sorted.length,
    lucidMoments: sorted.filter((f) => f.isLucid).length,
    dominantTheme: sorted.length > 0 ? (sorted[0].emotionalTone?.valence > 0.5 ? 'Reflective' : 'Unknown') : 'None',
  };
}

function runScript(script, args = []) {
  const result = spawnSync('bash', [path.join(PROJECT_ROOT, 'bin', script), ...args], {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function registerIpc() {
  ipcMain.handle('floki:get-initial-status', async () => {
    const webcamStatus = readChatWebcamVisionStatus();
    const vision = buildVisionStatus({
      active_mode: 'chat',
      webcam_status: webcamStatus
    });
    const life = sleepStatus();
    const pathConfig = getPathConfig('chat');
    const runtimeRoot = path.resolve(
      PROJECT_ROOT,
      pathConfig.chat_runtime_root
    );
    const runtimeStatus = readRuntimeStatus();
    const runtimeAwake = runtimeStatus.lifecycle?.is_awake === true;
    const hearingError = runtimeStatus.hearing?.last_error || runtimeStatus.hearing?.last_wake_gate_error || runtimeStatus.hearing_start_error || null;
    const hearingActive = Boolean(runtimeAwake && runtimeStatus.hearing_ready === true && !hearingError);

    return {
      connected: runtimeStatus.api_ready === true,
      state: runtimeStatus.state || life.state,
      mode: 'chat.local',
      cognitionModel: runtimeStatus.cognition_model || getModelConfig('chat').cognition.model,
      online: runtimeStatus.ready === true,
      visionActive: runtimeAwake && runtimeStatus.vision_ready === true,
      hearingActive,
      memoryLoaded: runtimeStatus.memory_loaded === true,
      speechActive: Boolean(runtimeAwake && runtimeStatus.hearing?.piper_ready === true && runtimeStatus.hearing?.playback_ready === true && !hearingError),
      sleepState: life.state,
      vision,
      runtime: runtimeStatus,
    };
  });
  ipcMain.handle('floki:get-system-status', async () => serviceStatus());
  ipcMain.handle('floki:get-transcript', async (_event, payload = {}) => readChatTranscriptTail(Number(payload.limit || 200)).map(normalizeTranscript));
  ipcMain.handle('floki:clear-transcript', async () => runtimeRequest('POST', '/transcript/clear', {}));
  ipcMain.handle('floki:send-message', async (_event, payload = {}) => {
    const text = String(payload.text || '').trim();
    if (!text) throw new Error('message text is required');
    if (requestInFlight) throw new Error('Floki is already responding');
    requestInFlight = true;
    try {
      const result = await runtimeRequest('POST', '/chat', { text });
      return {
        ok: result.ok,
        reply: result.reply || null,
        error: result.error || null,
        latency_events: result.latency_events || [],
        marker: result.marker,
      };
    } finally {
      requestInFlight = false;
    }
  });
  ipcMain.handle('floki:interrupt', async () => runtimeRequest('POST', '/interrupt', {}));
  ipcMain.handle('floki:get-vision-frame', async () => visionFrame());
  ipcMain.handle('floki:get-latest-frame', async () => getLatestFrameBase64());
  ipcMain.handle('floki:get-mjpeg-diag', async () => getMjpegDiag());
  ipcMain.handle('floki:get-mjpeg-port', async () => { const frameFile = process.env.FLOKI_E2E_FRAME_FILE || runtimePaths().latest_frame_file; return startMjpegServer(frameFile); });
  ipcMain.handle('floki:get-observation', async () => readLatestPrivateObservation());
  ipcMain.handle('floki:get-emotion', async () => { recordAffectHistory(); return emotionState(); });
  ipcMain.handle('floki:get-affect-history', async (_event, payload = {}) => {
    const paths = getPathConfig('chat');
    const historyFile = path.resolve(PROJECT_ROOT, paths.chat_runtime_root, 'affect-history.jsonl');
    const limit = Math.min(Number(payload.limit || AFFECT_HISTORY_MAX), AFFECT_HISTORY_MAX);
    return readJsonl(historyFile, limit);
  });
  ipcMain.handle('floki:get-sleep-status', async () => sleepStatus());
  ipcMain.handle('floki:get-neural-events', async (_event, payload = {}) => neuralEvents(Number(payload.limit || 250)));
  ipcMain.handle('floki:get-dream-timeline', async () => dreamTimeline());
  ipcMain.handle('floki:open-log', async (_event, payload = {}) => {
    const paths = getPathConfig('chat');
    const runtimeRoot = path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
    const diagnostics = path.join(PROJECT_ROOT, 'state/floki/diagnostics.jsonl');
    const candidates = {
      'Floki Core': diagnostics,
      'Cognition': diagnostics,
      'Vision': path.join(runtimeRoot, 'chat-webcam-vision.log'),
      'Chat Vision': path.join(runtimeRoot, 'chat-webcam-vision.log'),
      'Webcam Eyes': path.join(runtimeRoot, 'chat-webcam-vision.log'),
      'Hearing': path.join(runtimeRoot, 'chat-local-runtime.log'),
      'Speech': path.join(runtimeRoot, 'chat-local-runtime.log'),
      'Speech Listener': path.join(runtimeRoot, 'chat-local-runtime.log'),
      'Memory': diagnostics,
      'Emotion': diagnostics,
      'Sleep Scheduler': path.join(runtimeRoot, 'sleep-cycle-scheduler.log'),
      'Dream Engine': path.join(runtimeRoot, 'sleep-cycle-scheduler.log'),
      'Local API': path.join(runtimeRoot, 'chat-local-runtime.log'),
      'WebSocket Connection': diagnostics,
    };
    const file = candidates[payload.service] || path.join(PROJECT_ROOT, 'state/floki/diagnostics.jsonl');
    if (fs.existsSync(file)) await shell.openPath(file);
    return { ok: fs.existsSync(file), file };
  });
  ipcMain.handle('floki:control', async (_event, payload = {}) => {
    const action = String(payload.action || '');
    const visionStop = 'floki-chat-vision-stop.sh';
    const visionStart = 'floki-chat-vision-start.sh';
    const schedulerStop = 'floki-sleep-scheduler-stop.sh';
    const schedulerStart = 'floki-sleep-scheduler-start.sh';
    const map = {
      startChat: ['floki-chat-start.sh'],
      stopChat: ['floki-chat-stop.sh'],
      restartChat: ['floki-chat-stop.sh', 'floki-chat-start.sh'],
      restartVision: [visionStop, visionStart],
      restartHearing: ['floki-chat-stop.sh', 'floki-chat-start.sh'],
      restartSpeech: ['floki-chat-stop.sh', 'floki-chat-start.sh'],
      restartScheduler: [schedulerStop, schedulerStart],
      requestSleep: [schedulerStart],
      pauseSleep: [schedulerStop],
      resumeSleep: [schedulerStart],
      wake: [schedulerStop],
      pauseAutoSleep: [schedulerStop],
    };
    if (action === 'interrupt') return { ...(await runtimeRequest('POST', '/interrupt', {})), action };
    const scripts = map[action];
    if (!scripts) throw new Error(`unsupported control action: ${action}`);
    const results = scripts.map((script) => runScript(script));
    return { ok: results.every((result) => result.ok), action, results };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#030712',
    title: 'Floki Neural Interface',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(DIST_INDEX);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    void runtimeRequest('POST', '/client-ready', {}).catch((error) => {
      console.error('FLOKI_V2_CLIENT_READY_SIGNAL_FAIL: ' + error.message);
    });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    void runtimeRequest('POST', '/client-detached', {}).catch(() => {});
    mainWindow = null;
    cleanupProcesses();
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(`built interface missing: ${DIST_INDEX}`);
  }

  console.error('[FLOKI STARTUP 7/7] Connecting Electron to the authoritative chat.local runtime');
  const runtimeStatus = await runtimeRequest('GET', '/status');
  if (runtimeStatus.api_ready !== true || runtimeStatus.brain_loaded !== true) {
    throw new Error('authoritative chat.local runtime is not ready');
  }
  console.error('[FLOKI STARTUP 7/7] Shared brain, memory, and sleep state connected; eyes and ears remain suspended until the window is visible');

  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error(
    'FLOKI_V2_ELECTRON_STARTUP_FAIL: ' +
    String(error && error.stack ? error.stack : error)
  );
  app.exit(1);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
