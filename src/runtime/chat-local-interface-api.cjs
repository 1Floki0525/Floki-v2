'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT: ROOT, getModelConfig, getPathConfig, getVisionConfig } = require('../config/floki-config.cjs');
const { getInterfaceSettings, updateInterfaceSettings, resetInterfaceSettings, importInterfaceSettings } = require('../config/interface-settings.cjs');
const { readChatTranscriptTail, readPrivateThoughtTail, normalizePrivateThoughtText } = require('../chat/chat-transcript.cjs');
const { buildFlokiLifecycleStatus } = require('../chat/floki-lifecycle-status.cjs');
const { buildDreamTimeline } = require('../chat/dream-timeline.cjs');
const { readChatWebcamVisionStatus, readLatestPrivateObservation, runtimePaths } = require('../vision/chat-webcam-vision-service.cjs');
const { buildVisionStatus } = require('../vision/vision-status.cjs');
const { readLatestDetection, getDetectionConfig } = require('../vision/yolo-detection-service.cjs');
const { createInitialDetectionFrameState, reduceDetectionFrameState, splitDisplayDetections } = require('../vision/detection-frame-contract.cjs');
const { loadAffectState } = require('../../brain/emotions_base/index.cjs');
const { loadSelfImprovementConfig } = require('../self-improvement/config.cjs');
const { getAllModuleConfigs, DISPLAY_NAMES } = require('../control-plane/module-registry.cjs');
const { getCurrentWeekFile } = require('../control-plane/module-logging.cjs');

const AFFECT_HISTORY_MAX = 360;


function safeExistingFileWithin(root, candidate) {
  if (!root || !candidate) return null;
  try {
    const rootPath = fs.realpathSync(path.resolve(root));
    const candidatePath = fs.realpathSync(path.resolve(candidate));
    const relative = path.relative(rootPath, candidatePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return fs.statSync(candidatePath).isFile() ? candidatePath : null;
  } catch (_error) {
    return null;
  }
}

function safeDirectChildFileWithin(root, candidate, expectedBasename) {
  const filePath = safeExistingFileWithin(root, candidate);
  if (!filePath || path.basename(filePath) !== expectedBasename) return null;

  try {
    const rootPath = fs.realpathSync(path.resolve(root));
    const parentPath = fs.realpathSync(path.dirname(filePath));
    const relativeParent = path.relative(rootPath, parentPath);
    if (
      !relativeParent ||
      relativeParent.includes(path.sep) ||
      relativeParent.startsWith('..') ||
      path.isAbsolute(relativeParent) ||
      !/^[a-zA-Z0-9_.-]+$/.test(relativeParent)
    ) {
      return null;
    }
    return filePath;
  } catch (_error) {
    return null;
  }
}

function newestDirectChildFileWithin(root, expectedBasename) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return null;
  }

  let newest = null;
  let newestMtimeMs = -1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = safeDirectChildFileWithin(
      root,
      path.join(root, entry.name, expectedBasename),
      expectedBasename
    );
    if (!candidate) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = Number(fs.statSync(candidate).mtimeMs || 0);
    } catch (_error) {
      continue;
    }
    if (mtimeMs > newestMtimeMs) {
      newest = candidate;
      newestMtimeMs = mtimeMs;
    }
  }
  return newest;
}

const INTERFACE_TAB_CONTRACT = Object.freeze({
  chat: Object.freeze({ reads: Object.freeze(['status', 'transcript']), writes: Object.freeze(['sendMessage', 'clearTranscript', 'interrupt']), live_events: Object.freeze(['transcript.entry', 'transcript.remove', 'status.update']) }),
  dreams: Object.freeze({ reads: Object.freeze(['dreamTimeline', 'sleep']), writes: Object.freeze(['requestSleep', 'wake']), live_events: Object.freeze(['status.update', 'inner-stream.entry']) }),
  neural: Object.freeze({ reads: Object.freeze(['neuralEvents']), writes: Object.freeze([]), live_events: Object.freeze(['inner-stream.entry']) }),
  rsi_lab: Object.freeze({ reads: Object.freeze(['selfImprovementStatus', 'selfImprovementCandidates', 'selfImprovementActivity']), writes: Object.freeze(['runSelfImprovementNow', 'pauseSelfImprovement', 'resumeSelfImprovement', 'approveSelfImprovement', 'denySelfImprovement']), live_events: Object.freeze(['status.update']) }),
  system: Object.freeze({ reads: Object.freeze(['services', 'visionFrame', 'visionObservation', 'emotion', 'affectHistory', 'sleep', 'logPath']), writes: Object.freeze(['startChat', 'stopChat', 'restartChat', 'wake', 'requestSleep', 'pauseSleep', 'resumeSleep', 'restartVision', 'restartHearing', 'restartSpeech', 'controlModule', 'interrupt', 'pushToTalk']), live_events: Object.freeze(['status.update']) }),
  settings: Object.freeze({ reads: Object.freeze(['settings']), writes: Object.freeze(['updateSettings', 'resetSettings', 'importSettings']), live_events: Object.freeze(['status.update']) })
});

function safeJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) { return fallback; }
}

function readJsonl(filePath, limit = 250) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit || 250)))
      .map((line) => { try { return JSON.parse(line); } catch (_error) { return null; } })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (_error) { return false; }
}

function readPidFile(filePath) {
  try {
    const value = Number(String(fs.readFileSync(filePath, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

function safeFileTime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch (_error) { return 0; }
}

function uptimeFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Math.max(0, Date.now() - Number(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || Date.now()));
  } catch (_error) {
    return 0;
  }
}

function normalizeTranscript(entry) {
  return Object.freeze({
    id: entry.id || `${entry.created_at || Date.now()}-${entry.role || 'unknown'}`,
    role: entry.role === 'floki' ? 'assistant' : 'user',
    content: String(entry.text || ''),
    type: entry.input_modality === 'spoken' || entry.output_modality === 'spoken' ? 'spoken' : 'typed',
    timestamp: Date.parse(entry.created_at || entry.timestamp || '') || Date.now(),
    isPartial: entry.transcript_state === 'partial',
    isStreaming: entry.transcript_state === 'partial',
    latency: null
  });
}

function emotionState() {
  const state = loadAffectState({ persist_diagnostics: false });
  const core = state.core || {};
  const emotions = state.emotions || {};
  return Object.freeze({
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
    timestamp: Date.parse(state.updated_at || '') || Date.now()
  });
}

function createChatLocalInterfaceApi(options = {}) {
  const runtimeDir = path.resolve(options.runtime_dir || path.join(ROOT, getPathConfig('chat').chat_runtime_root));
  const transcriptOptions = Object.freeze({ ...(options.transcript_options || {}) });
  const runtimeStatus = typeof options.status === 'function' ? options.status : () => safeJson(path.join(runtimeDir, 'chat-local-runtime.status.json'), {});
  const startedAt = Number(options.started_at || Date.now());
  const sessionId = options.session_id || null;
  let lastRecordedAffectSignature = '';
  let visionFrameState = createInitialDetectionFrameState();
  const visionConfig = getVisionConfig('chat');
  const visionPaths = runtimePaths({ runtime_dir: runtimeDir });
  const selfImprovementConfig = loadSelfImprovementConfig();
  const frameFreshnessMs = Math.max(
    100,
    Number(visionConfig.frame_retention_seconds || 0) * 1000 +
      Number(visionConfig.capture_timeout_grace_ms || 0)
  );

  function latestFrameState(now = Date.now()) {
    try {
      const stat = fs.statSync(visionPaths.latest_frame_file);
      const mtimeMs = Number(stat.mtimeMs || 0);
      const ageMs = Math.max(0, Number(now) - mtimeMs);
      const available = Number(stat.size || 0) > 0;
      const fresh = available && ageMs <= frameFreshnessMs;
      return Object.freeze({
        available,
        fresh,
        stale: available && !fresh,
        ageMs,
        mtimeMs,
        size: Number(stat.size || 0)
      });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return Object.freeze({ available: false, fresh: false, stale: false, ageMs: null, mtimeMs: 0, size: 0 });
      }
      throw error;
    }
  }

  function recordAffectHistory() {
    const historyFile = path.join(runtimeDir, 'affect-history.jsonl');
    const current = emotionState();
    const signature = [current.valence, current.arousal, current.trust, current.curiosity, current.timestamp].join('|');
    if (signature === lastRecordedAffectSignature) return current;
    lastRecordedAffectSignature = signature;
    appendJsonl(historyFile, current);
    const all = readJsonl(historyFile, AFFECT_HISTORY_MAX);
    if (all.length >= AFFECT_HISTORY_MAX) {
      const trimmed = all.slice(-Math.floor(AFFECT_HISTORY_MAX * 0.75));
      fs.writeFileSync(historyFile, trimmed.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    }
    return current;
  }

  function buildSleep() {
    const lifecycle = buildFlokiLifecycleStatus();
    const affect = loadAffectState({ persist_diagnostics: false });
    const current = runtimeStatus();
    const sleepPressure = Number(affect && affect.regulation && affect.regulation.sleep_pressure || 0);
    const manualNap = lifecycle.manual_nap || null;
    return Object.freeze({
      state: String(lifecycle.state || 'awake').replace(/(^|_)([a-z])/g, (_match, prefix, letter) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`),
      alertness: Math.max(0, 1 - sleepPressure),
      sleepPressure,
      remActive: lifecycle.state === 'rem' || lifecycle.current_rem_cycle_number != null,
      currentRemCycle: Number(lifecycle.current_rem_cycle_number || 0),
      dreaming: lifecycle.state === 'dreaming' || lifecycle.state === 'rem',
      thinking: current.active_turn === true,
      speaking: current.hearing && current.hearing.speaking === true,
      listening: current.hearing && current.hearing.service_state === 'listening',
      externalEyesActive: readChatWebcamVisionStatus({ runtime_dir: runtimeDir }).capture_live === true,
      currentMode: 'Chat Local',
      lastInteraction: Date.now(),
      sessionUptime: Date.now() - startedAt,
      manualNap,
      raw: lifecycle
    });
  }

  function buildVisionFrame() {
    const now = Date.now();
    const service = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
    const observation = readLatestPrivateObservation({ runtime_dir: runtimeDir });
    const latestDetection = readLatestDetection({ runtime_dir: runtimeDir });
    const detectionConfig = getDetectionConfig();
    const frame = latestFrameState(now);
    const cameraActive = service.capture_live === true;
    const liveFrame = cameraActive && frame.available === true && frame.fresh === true;
    const rawDetections = liveFrame && latestDetection.available === true && latestDetection.fresh === true && latestDetection.detection
      ? (Array.isArray(latestDetection.detection.detections) ? latestDetection.detection.detections : [])
      : [];
    if (!liveFrame) {
      visionFrameState = createInitialDetectionFrameState();
    }
    const settings = getInterfaceSettings('chat').vision;
    const showObjects = settings.showObjectBoxes !== false;
    const showPersons = settings.showPersonBoxes !== false;
    const showFaceBoxes = settings.showFaceBoxes !== false;
    const showRecognizedNames = settings.showRecognizedNames !== false;
    const showLabels = settings.showLabels !== false;
    const showConfidence = settings.showConfidence !== false;
    const showSceneRecognition = settings.showSceneRecognition !== false;
    const display = liveFrame && latestDetection.available === true && latestDetection.fresh === true && latestDetection.detection
      ? splitDisplayDetections(latestDetection.detection, {
          now_ms: now,
          max_age_ms: detectionConfig.maxAgeMs
        })
      : null;
    if (display) {
      const reduced = reduceDetectionFrameState(visionFrameState, latestDetection.detection, {
        now_ms: now,
        max_age_ms: detectionConfig.maxAgeMs,
        accept_new_session: true
      });
      visionFrameState = reduced.state;
    } else if (!liveFrame || latestDetection.stale === true) {
      visionFrameState = createInitialDetectionFrameState();
    }
    const rawObjects = liveFrame && display ? display.objects : [];
    const rawPersons = liveFrame && display ? display.persons : [];
    const rawFaces = liveFrame && display ? display.faces : [];
    const objects = showObjects ? rawObjects : [];
    const persons = showPersons ? rawPersons : [];
    const faces = showFaceBoxes ? rawFaces : [];
    const recognizedNames = showRecognizedNames ? [] : [];
    const sceneAvailable = Boolean(
      liveFrame &&
      observation &&
      observation.available === true &&
      observation.fresh === true &&
      typeof observation.observation_summary === 'string' &&
      observation.observation_summary.trim()
    );
    const scene = showSceneRecognition
      ? { available: sceneAvailable, label: sceneAvailable ? observation.observation_summary.trim() : '', confidence: null }
      : { available: false, label: '', confidence: null };
    const objectDetections = showLabels
      ? objects
      : objects.map((entry) => ({ ...entry, label: undefined, name: undefined, class: undefined }));
    const personDetections = showLabels
      ? persons
      : persons.map((entry) => ({ ...entry, label: undefined, name: undefined, class: undefined }));
    const objectCount = showObjects ? objectDetections.length : 0;
    const personCount = showPersons ? personDetections.length : 0;
    const showBoundingBoxes = showObjects || showPersons || showFaceBoxes;
    return Object.freeze({
      objects: showBoundingBoxes ? objectDetections : [],
      persons: showBoundingBoxes ? personDetections : [],
      faces,
      recognized_names: recognizedNames,
      scene,
      show_labels: showLabels,
      show_confidence: showConfidence,
      show_bounding_boxes: showBoundingBoxes,
      detection: {
        available: liveFrame && latestDetection.available === true,
        fresh: liveFrame && latestDetection.fresh === true,
        stale: !liveFrame || latestDetection.stale === true,
        ageMs: latestDetection.age_ms,
        maxAgeMs: detectionConfig.maxAgeMs,
        frameId: latestDetection.detection ? latestDetection.detection.frame_id || null : null,
        frameSequence: latestDetection.detection ? latestDetection.detection.frame_sequence ?? null : null,
        resultSequence: latestDetection.detection ? latestDetection.detection.result_sequence ?? null : null,
        streamSessionId: latestDetection.detection ? latestDetection.detection.stream_session_id || null : null,
        capturedAt: latestDetection.detection ? latestDetection.detection.captured_at || null : null,
        detectedAt: latestDetection.detection ? latestDetection.detection.detected_at || null : null,
        dropped: latestDetection.detection ? latestDetection.detection.dropped_detections || null : null,
        overlayDropCounts: visionFrameState.dropCounts || null,
        error: latestDetection.error || service.last_yolo_error || null,
        rawCount: rawDetections.length,
        objectCount,
        personCount
      },
      frame: Object.freeze({
        ...frame,
        width: latestDetection.detection ? latestDetection.detection.image_width || null : null,
        height: latestDetection.detection ? latestDetection.detection.image_height || null : null
      }),
      streamSessionId: latestDetection.detection ? latestDetection.detection.stream_session_id || null : null,
      timestamp: frame.mtimeMs || now,
      frameRate: liveFrame ? Number(service.measured_capture_fps || 0) : 0,
      connectionStatus: liveFrame ? 'active' : (cameraActive ? 'warming' : 'offline'),
      service,
      observation
    });
  }

  function latestFrameBase64() {
    const frame = latestFrameState();
    if (!frame.available || !frame.fresh || frame.size <= 0) return null;
    const data = fs.readFileSync(visionPaths.latest_frame_file);
    return 'data:image/jpeg;base64,' + data.toString('base64');
  }

  function buildServices() {
    const current = runtimeStatus();
    const lifecycle = buildFlokiLifecycleStatus();

    const exclusiveTraining = ['entering', 'active', 'restoring'].includes(
      String(current.training_resource_mode || '')
    );
    const exclusiveTrainingDetail =
      selfImprovementConfig.training_exclusive_status_label;
    const trainingControlPlaneNames = new Set([
      'authoritative_api',
      'live_event_stream',
      'rsi'
    ]);

    const modules = getAllModuleConfigs();
    const rows = modules.map((module) => {
      const app = module.client_app_status || null;
      const heartbeat = app && app.last_heartbeat_at
        ? Date.parse(app.last_heartbeat_at)
        : module.heartbeat_file ? safeFileTime(module.heartbeat_file) : Date.now();
      const uptime = app ? app.session_uptime_ms : module.uptime_file ? uptimeFromFile(module.uptime_file) : 0;
      const detail = buildModuleDetail(module.key, current, lifecycle, module);
      const dependencyWarning = buildDependencyWarning(module.key, modules, module.status);

      return Object.freeze({
        key: module.key,
        name: module.name,
        status: formatDisplayStatus(module.status),
        lifecycleState: module.status,
        startAvailable: true,
        stopAvailable: true,
        resetAvailable: true,
        restartAvailable: true,
        logAvailable: module.log_available === true,
        logKey: module.log_key,
        requiresConfirmation: module.requires_confirmation,
        dependencyWarning,
        lastHeartbeat: heartbeat,
        uptime,
        latency: 0,
        detail,
        lastError: app ? app.last_reported_error : null,
        clientApp: module.client_app === true,
        enabled: app ? app.enabled : module.status !== 'stopped',
        connectedClientCount: app ? app.connected_client_count : null,
        healthyClientCount: app ? app.healthy_client_count : null,
        connectedSince: app ? app.connected_since : null,
        transportType: app ? app.transport_type : null,
        controlGeneration: app ? app.control_generation : null,
        staleClientCount: app ? app.stale_client_count : null
      });
    });

    if (!exclusiveTraining) return Object.freeze(rows);

    return Object.freeze(rows.map((row) => {
      if (trainingControlPlaneNames.has(row.key)) {
        if (row.key === 'rsi') return row;
        return Object.freeze({
          ...row,
          detail: row.detail + ' Exclusive-training control plane remains online.'
        });
      }
      return Object.freeze({
        ...row,
        status: 'Stopped',
        lifecycleState: 'stopped',
        startAvailable: false,
        stopAvailable: false,
        resetAvailable: false,
        lastError: null,
        detail: exclusiveTrainingDetail
      });
    }));
  }

  function formatDisplayStatus(status) {
    if (!status) return 'Unknown';
    return String(status).replace(/^\w/, (c) => c.toUpperCase());
  }

  function buildDependencyWarning(moduleKey, allModules, moduleStatus) {
    const module = allModules.find((m) => m.key === moduleKey);
    if (!module || !module.dependencies || module.dependencies.length === 0) return '';
    const missing = module.dependencies
      .map((depKey) => allModules.find((m) => m.key === depKey))
      .filter((dep) => dep && dep.status !== 'running')
      .map((dep) => dep.name);
    if (missing.length === 0) return '';
    return `Requires ${missing.join(', ')}`;
  }

  function buildModuleDetail(moduleKey, current, lifecycle, module) {
    const webcam = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
    const model = getModelConfig('chat').cognition;
    const knowledge = current.knowledge_autoload || {};
    switch (moduleKey) {
      case 'floki_core':
        return 'The authoritative chat.local runtime owns cognition, memory, hearing, sight, sleep, dreams, and interface data.';
      case 'cognition':
        return `Configured model: ${model.model}; runtime session ${current.session_id || 'unknown'}.`;
      case 'vision':
        return `Eyes ${webcam.capture_live === true ? 'live' : (webcam.camera_open === true ? 'warming' : 'closed')} · ${Number(webcam.measured_capture_fps || 0).toFixed(1)} FPS · detector ${webcam.detection_live === true ? 'live' : 'stale'} · scene ${webcam.scene_live === true ? 'available' : 'refreshing'}.`;
      case 'hearing':
        return lifecycle && lifecycle.is_awake === false ? 'Ears are intentionally closed while asleep.' : 'Continuous microphone, VAD, Whisper, and wake continuation are owned by the authoritative runtime.';
      case 'speech':
        return lifecycle && lifecycle.is_awake === false ? 'Voice is inactive while asleep.' : 'Piper playback and self-echo locking are owned by the authoritative runtime.';
      case 'memory':
        return 'Persistent memory and transcript knowledge are attached to the authoritative brain runtime. Knowledge status: ' + String(knowledge.marker || 'not loaded') + '; phase ' + String(knowledge.phase || 'unknown') + '; sources ' + String(knowledge.source_count || 0) + '; chunks ' + String(knowledge.chunk_count || 0) + '.';
      case 'emotion':
        return 'Persistent affect state is attached to cognition and the interface.';
      case 'sleep_scheduler':
        return lifecycle.sleep_cycle_scheduler_note || 'Sleep scheduler state unavailable.';
      case 'dream_engine':
        return lifecycle.is_dreaming ? 'REM dream generation is active.' : 'Dream generation is scheduled by the sleep runtime.';
      case 'authoritative_api':
        return 'All interface tabs use this single chat.local backend.';
      case 'live_event_stream':
        return 'Transcript, inner experience, status, sleep, and sensory updates are delivered from the authoritative runtime.';
      case 'web_app':
      case 'mobile_app': {
        const app = module.client_app_status || {};
        const connected = Number(app.connected_client_count || 0);
        const healthy = Number(app.healthy_client_count || 0);
        const transport = app.transport_type || 'none';
        const generation = Number(app.control_generation || 1);
        const enabled = app.enabled === true ? 'enabled' : 'disabled';
        return `${module.name} connection service is ${enabled}; ${healthy}/${connected} healthy clients over ${transport}; generation ${generation}.`;
      }
      case 'rsi':
        return 'Recursive self-improvement worker and sandbox lifecycle.';
      default:
        return 'Module controlled through authoritative registry.';
    }
  }

  function naturalInnerText(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 1200) return false;
    if (!/^I\b/i.test(text)) return false;
    if (/\{\s*"|\b(pid|process id|trace id|event id|payload|marker|transport|file path)\b/i.test(text)) return false;
    return true;
  }

  function buildNeuralEvents(limit = 250) {
    const settings = getInterfaceSettings('chat').neuralStream;
    const seen = new Set();
    const entries = readPrivateThoughtTail(Math.max(Number(limit || 250) * 4, 250), transcriptOptions)
      .filter((entry) => settings.sessionOnly !== true || !sessionId || entry.session_id === sessionId)
      .filter((entry) => naturalInnerText(entry.text))
      .filter((entry) => {
        const key = String(entry.category || 'reflection') + ':' + normalizePrivateThoughtText(entry.text);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-Math.max(1, Number(limit || 250)));
    return entries.map((entry) => Object.freeze({
      id: entry.id,
      timestamp: Date.parse(entry.created_at || '') || Date.now(),
      module: String(entry.category || 'reflection').replace(/(^|_)([a-z])/g, (_m, _p, c) => c.toUpperCase()),
      category: entry.category || 'reflection',
      summary: entry.text,
      severity: entry.severity || 'info'
    }));
  }

  function buildInitialStatus() {
    const current = runtimeStatus();
    const life = buildSleep();
    const webcam = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
    return Object.freeze({
      connected: current.api_ready === true,
      state: current.state || life.state,
      mode: 'chat.local',
      cognitionModel: current.cognition_model || getModelConfig('chat').cognition.model,
      online: current.api_ready === true && current.brain_loaded === true,
      fullyReady: current.ready === true,
      visionActive: current.lifecycle && current.lifecycle.is_awake === true && webcam.camera_open === true && latestFrameState().fresh === true,
      hearingActive: current.lifecycle && current.lifecycle.is_awake === true && current.hearing_ready === true,
      memoryLoaded: current.memory_loaded === true && current.knowledge_ready === true,
      speechActive: Boolean(current.lifecycle && current.lifecycle.is_awake === true && current.hearing && current.hearing.piper_ready === true && current.hearing.playback_ready === true),
      sleepState: life.state,
      vision: buildVisionStatus({ active_mode: 'chat', webcam_status: webcam }),
      runtime: current
    });
  }

  function selfImprovementWorkerLog() {
    return safeExistingFileWithin(
      selfImprovementConfig.runtime_root,
      path.join(
        selfImprovementConfig.runtime_root,
        selfImprovementConfig.worker_log_name
      )
    );
  }

  function selfImprovementSandboxLog() {
    const statusFile = path.join(
      selfImprovementConfig.runtime_root,
      selfImprovementConfig.status_file_name
    );
    const status = safeJson(statusFile, {});
    const candidate = status?.last_sandbox_log_file
      ? String(status.last_sandbox_log_file)
      : null;
    const recorded = safeDirectChildFileWithin(
      selfImprovementConfig.workspace_root,
      candidate,
      selfImprovementConfig.sandbox_log_file_name
    );
    if (recorded) return recorded;
    return newestDirectChildFileWithin(
      selfImprovementConfig.workspace_root,
      selfImprovementConfig.sandbox_log_file_name
    );
  }

  function logPath(service) {
    const key = String(service || '');
    try {
      const filePath = getCurrentWeekFile(key);
      return Object.freeze({ service: key, path: filePath, exists: fs.existsSync(filePath) });
    } catch (_error) {
      const legacy = legacyLogPath(key);
      if (legacy && legacy.path) return legacy;
      return Object.freeze({ service: key, path: null, exists: false });
    }
  }

  function legacyLogPath(key) {
    const diagnostics = path.join(ROOT, 'state/floki/diagnostics.jsonl');
    const candidates = {
      floki_core: path.join(runtimeDir, 'chat-local-runtime.log'),
      cognition: diagnostics,
      vision: path.join(runtimeDir, 'chat-webcam-vision.log'),
      hearing: path.join(runtimeDir, 'chat-local-runtime.log'),
      speech: path.join(runtimeDir, 'chat-local-runtime.log'),
      memory: diagnostics,
      emotion: diagnostics,
      sleep_scheduler: path.join(runtimeDir, 'sleep-cycle-scheduler.log'),
      dream_engine: path.join(runtimeDir, 'sleep-cycle-scheduler.log'),
      authoritative_api: path.join(runtimeDir, 'chat-local-runtime.log'),
      live_event_stream: path.join(runtimeDir, 'chat-local-runtime.log'),
      web_app: null,
      mobile_app: null,
      rsi: selfImprovementWorkerLog() || selfImprovementSandboxLog()
    };
    const displayMap = Object.fromEntries(
      Object.entries(DISPLAY_NAMES || {}).map(([k, name]) => [name, k])
    );
    const moduleKey = candidates[key] ? key : displayMap[key];
    const filePath = moduleKey ? candidates[moduleKey] : null;
    return filePath
      ? Object.freeze({ service: key, path: filePath, exists: fs.existsSync(filePath) })
      : Object.freeze({ service: key, path: null, exists: false });
  }

  return Object.freeze({
    buildInitialStatus,
    buildServices,
    buildVisionFrame,
    latestFrameBase64,
    buildObservation: () => readLatestPrivateObservation({ runtime_dir: runtimeDir }),
    buildEmotion: () => recordAffectHistory(),
    buildAffectHistory: (limit = AFFECT_HISTORY_MAX) => readJsonl(path.join(runtimeDir, 'affect-history.jsonl'), Math.min(Number(limit || AFFECT_HISTORY_MAX), AFFECT_HISTORY_MAX)),
    buildSleep,
    buildNeuralEvents,
    buildDreamTimeline,
    getTranscript: (limit = 200) => readChatTranscriptTail(limit, transcriptOptions).map(normalizeTranscript),
    getSettings: () => getInterfaceSettings('chat'),
    updateSettings: (section, values) => updateInterfaceSettings(section, values, 'chat'),
    resetSettings: (section = null) => resetInterfaceSettings(section, 'chat'),
    importSettings: (settings) => importInterfaceSettings(settings, 'chat'),
    logPath,
    coverage: () => Object.freeze({
      connected: true,
      authoritative_backend: 'src/runtime/chat-local-runtime.cjs',
      backend_owners: 1,
      mock_mode: false,
      tabs: INTERFACE_TAB_CONTRACT,
      websocket_events: Object.freeze(['transcript.entry', 'transcript.remove', 'inner-stream.entry', 'status.update'])
    })
  });
}

module.exports = {
  INTERFACE_TAB_CONTRACT,
  createChatLocalInterfaceApi,
  normalizeTranscript,
  safeDirectChildFileWithin,
  safeExistingFileWithin
};
