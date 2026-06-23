'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');

const HOST = process.env.FLOKI_CHAT_LOCAL_HOST || '127.0.0.1';
const PORT = Number(process.env.FLOKI_CHAT_LOCAL_PORT || 7700);
const ROOT = path.resolve(
  process.env.FLOKI_PROJECT_ROOT || path.join(__dirname, '..', '..', '..')
);
const STARTED_AT = Date.now();

function projectRequire(relativePath) {
  return require(path.join(ROOT, relativePath));
}

const { createRuntime } = projectRequire('src/chat/floki-chat.cjs');
const { handleTypedText, startKnowledgeAutoload } = projectRequire('src/chat/floki-live-chat-interface.cjs');
const { buildChatModeStatus } = projectRequire('src/chat/chat-mode-status.cjs');
const { buildFlokiLifecycleStatus } = projectRequire('src/chat/floki-lifecycle-status.cjs');
const { buildDreamStatus } = projectRequire('src/chat/dream-status.cjs');
const { buildDreamTimeline: buildSharedDreamTimeline } = projectRequire('src/chat/dream-timeline.cjs');
const {
  readChatWebcamVisionStatus,
  readLatestPrivateObservation
} = projectRequire('src/vision/chat-webcam-vision-service.cjs');
const { statePath } = projectRequire('src/util/fs-safe.cjs');
const { getPathConfig } = projectRequire('src/config/floki-config.cjs');

let runtime = null;
let activeRequest = null;
let neuralEventCursor = 0;
let knowledgeAutoloadStatus = null;

function runtimeInstance() {
  if (!runtime) runtime = createRuntime({ session_id: 'chat_local_' + process.pid });
  return runtime;
}

function nowMs() {
  return Date.now();
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function safeReadJsonl(filePath, limit = 250) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch (_error) { return null; }
    }).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (_error) { return false; }
}

function pidStatus(filePath) {
  try {
    const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
    return { pid, active: processAlive(pid) };
  } catch (_error) {
    return { pid: null, active: false };
  }
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('request body exceeds 1 MiB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_error) { reject(new Error('request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function mapLifecycleState(status) {
  if (status.state === 'rem_dreaming') return 'Dreaming';
  if (status.state === 'asleep') return 'Asleep';
  if (status.state === 'awake_sleep_interrupted') return 'Alert';
  return 'Awake';
}

function buildStatus() {
  const chat = buildChatModeStatus();
  const lifecycle = chat.lifecycle_status || buildFlokiLifecycleStatus();
  const vision = readChatWebcamVisionStatus();
  const hearingPid = pidStatus(statePath('chat/runtime/chat-mode-loop.pid'));
  return {
    online: true,
    mode: 'Chat Mode · Local GUI',
    visionActive: vision.active === true && vision.ready_for_chat === true,
    hearingActive: hearingPid.active,
    state: activeRequest ? activeRequest.state : (lifecycle.is_asleep ? 'Sleeping' : 'Idle'),
    sleepState: mapLifecycleState(lifecycle),
    cognitionModel: chat.qwen_cognition && chat.qwen_cognition.model,
    apiVersion: 'floki-chat-local-v1',
    chatModeOnly: true,
    gameModeStarted: false
  };
}

function buildVisionFrame() {
  const status = readChatWebcamVisionStatus();
  const active = status.active === true && status.ready_for_chat === true;
  return {
    objects: [],
    faces: [],
    scene: {
      label: active ? 'Real webcam service active; raw frames are not persisted' : 'Webcam service unavailable',
      confidence: active ? 1 : 0
    },
    timestamp: status.last_frame_timestamp ? Date.parse(status.last_frame_timestamp) : nowMs(),
    frameRate: Number(status.measured_capture_fps || 0),
    connectionStatus: active ? 'active' : 'offline',
    rawFrameAvailable: false,
    rawFrameStorageEnabled: false,
    privacyReason: 'Floki processes webcam frames in memory and stores only the private VLM observation.',
    serviceStatus: status
  };
}

function observationFreshness(observation) {
  if (!observation || observation.available !== true) {
    return observation && observation.stale === true ? 'Stale' : 'Offline';
  }
  const ageSeconds = Number(observation.observation_age_ms || 0) / 1000;
  if (ageSeconds <= 2) return 'Live';
  if (ageSeconds <= 15) return 'Fresh';
  if (ageSeconds <= 30) return 'Aging';
  return 'Stale';
}

function buildObservation() {
  const observation = readLatestPrivateObservation();
  const timestamp = observation.latest_private_observation_timestamp
    ? Date.parse(observation.latest_private_observation_timestamp)
    : nowMs();
  return {
    text: observation.available === true
      ? observation.observation_summary
      : 'No current visual observation is available.',
    age: Math.max(0, Math.round(Number(observation.observation_age_ms || 0) / 1000)),
    freshness: observationFreshness(observation),
    source: observation.source || 'webcam',
    lastUpdated: Number.isFinite(timestamp) ? timestamp : nowMs(),
    sightScope: observation.sight_scope || null,
    available: observation.available === true,
    unavailableReason: observation.unavailable_reason || null
  };
}

function clamp01(value) {
  const number = Number(value || 0);
  return Math.max(0, Math.min(1, Number.isFinite(number) ? number : 0));
}

function buildEmotion() {
  const state = safeReadJson(statePath('affect.json'), {});
  const core = state.core || {};
  const emotions = state.emotions || {};
  return {
    valence: clamp01((Number(core.valence || 0) + 1) / 2),
    arousal: clamp01(core.arousal),
    trust: clamp01(emotions.trust),
    curiosity: clamp01(emotions.curiosity),
    hope: clamp01(emotions.hope),
    fear: clamp01(emotions.fear),
    frustration: clamp01(emotions.frustration),
    attachment: clamp01(emotions.attachment),
    confidence: clamp01((Number(core.dominance || 0) + 1) / 2),
    uncertainty: clamp01(emotions.uncertainty),
    timestamp: state.updated_at ? Date.parse(state.updated_at) : nowMs(),
    mood: state.mood && state.mood.label ? state.mood.label : 'neutral'
  };
}

function buildSleep() {
  const lifecycle = buildFlokiLifecycleStatus();
  const vision = readChatWebcamVisionStatus();
  const hearingPid = pidStatus(statePath('chat/runtime/chat-mode-loop.pid'));
  const affect = safeReadJson(statePath('affect.json'), {});
  const regulation = affect.regulation || {};
  return {
    state: mapLifecycleState(lifecycle),
    alertness: lifecycle.is_awake ? 1 : lifecycle.is_rem_dreaming ? 0.15 : 0.3,
    sleepPressure: clamp01(regulation.sleep_pressure),
    remActive: lifecycle.is_rem_dreaming === true,
    currentRemCycle: Number(lifecycle.current_rem_cycle_number || 0),
    dreaming: lifecycle.is_dreaming === true,
    thinking: Boolean(activeRequest),
    speaking: activeRequest ? activeRequest.state === 'Speaking' : false,
    listening: hearingPid.active,
    externalEyesActive: vision.active === true && vision.ready_for_chat === true,
    currentMode: 'Chat Mode · Local GUI',
    lastInteraction: lifecycle.last_transition_at ? Date.parse(lifecycle.last_transition_at) : nowMs(),
    sessionUptime: STARTED_AT,
    schedulerRunning: lifecycle.sleep_cycle_scheduler_running === true,
    nextRemCycleAt: lifecycle.next_rem_cycle_at || null
  };
}

function service(name, active, options = {}) {
  return {
    name,
    status: active ? 'Running' : (options.degraded ? 'Degraded' : 'Stopped'),
    lastHeartbeat: Number(options.lastHeartbeat || nowMs()),
    uptime: active ? Math.max(0, nowMs() - Number(options.startedAt || STARTED_AT)) : 0,
    latency: Number(options.latency || 0),
    lastError: options.lastError || null,
    restartAction: options.restartAction || null,
    restartAvailable: Boolean(options.restartAction),
    logPath: options.logPath || null,
    logAvailable: Boolean(options.logPath)
  };
}

function buildServices() {
  const lifecycle = buildFlokiLifecycleStatus();
  const vision = readChatWebcamVisionStatus();
  const hearing = pidStatus(statePath('chat/runtime/chat-mode-loop.pid'));
  const runtimeRoot = statePath('chat/runtime');
  return [
    service('Local API', true, { logPath: path.join(runtimeRoot, 'chat-local-api.log') }),
    service('Core Brain', true),
    service('Cognition', true),
    service('Vision', vision.active === true && vision.ready_for_chat === true, {
      degraded: vision.active === true && vision.ready_for_chat !== true,
      lastHeartbeat: vision.service_heartbeat ? Date.parse(vision.service_heartbeat) : nowMs(),
      lastError: vision.last_fatal_error || vision.last_vlm_error || null,
      restartAction: 'restartVision',
      logPath: path.join(runtimeRoot, 'chat-webcam-vision.log')
    }),
    service('Hearing', hearing.active, {
      restartAction: 'restartHearing',
      logPath: path.join(runtimeRoot, 'chat-mode-loop.log')
    }),
    service('Speech', hearing.active, {
      restartAction: 'restartSpeech',
      logPath: path.join(ROOT, '.floki-tools', 'output', 'spoken-reply-once', 'latest-spoken-reply-once.json')
    }),
    service('Sleep Scheduler', lifecycle.sleep_cycle_scheduler_running === true, {
      restartAction: 'resumeSleep',
      logPath: path.join(runtimeRoot, 'sleep-cycle-scheduler.log')
    }),
    service('Minecraft Bridge', false)
  ];
}

function buildDreamTimeline() {
  return buildSharedDreamTimeline();
}

function latencyLogPath() {
  const paths = getPathConfig('chat');
  return path.resolve(ROOT, paths.chat_runtime_root, 'latency-events.jsonl');
}

function moduleForLatencyEvent(eventName) {
  const event = String(eventName || '');
  if (event.includes('vision')) return 'Vision';
  if (event.includes('memory')) return 'Memory';
  if (event.includes('model') || event.includes('schema')) return 'Frontal';
  if (event.includes('safe_public') || event.includes('broca') || event.includes('tts') || event.includes('playback')) return 'Broca';
  return 'System';
}

function latencyEventToNeural(event) {
  return {
    id: `${event.trace_id || 'latency'}:${event.event}:${event.elapsed_ms}`,
    timestamp: Date.parse(event.wall_clock_timestamp || '') || nowMs(),
    module: moduleForLatencyEvent(event.event),
    eventType: String(event.event || 'latency'),
    summary: `${event.event} at ${Math.round(Number(event.elapsed_ms || 0))}ms`,
    severity: event.event === 'response_failed' ? 'error' : event.event === 'response_interrupted' ? 'warning' : 'info',
    traceId: String(event.trace_id || ''),
    duration: Number(event.elapsed_from_previous_ms || 0),
    privacyLevel: 'Safe Summary'
  };
}

function buildNeuralEvents() {
  const events = safeReadJsonl(latencyLogPath(), 300);
  const start = Math.min(neuralEventCursor, events.length);
  const next = events.slice(start).map(latencyEventToNeural);
  neuralEventCursor = events.length;
  return next;
}

function latencySummary(events) {
  const list = Array.isArray(events) ? events : [];
  const at = (name) => {
    const event = list.find((item) => item.event === name);
    return event ? Number(event.elapsed_ms || 0) : 0;
  };
  const delta = (from, to) => Math.max(0, at(to) - at(from));
  const completed = at('response_completed') || at('response_failed') || at('response_interrupted');
  return {
    transcriptionTime: 0,
    memoryContextTime: delta('cached_vision_ready', 'memory_context_ready'),
    visionContextTime: at('cached_vision_ready'),
    cognitionTime: delta('model_dispatched', 'final_model_output'),
    timeToFirstToken: at('first_response_chunk'),
    totalGenerationTime: delta('model_dispatched', 'final_model_output'),
    textToSpeechTime: at('tts_ready') ? delta('tts_started', 'tts_ready') : 0,
    totalResponseTime: completed,
    traceId: list[0] && list[0].trace_id ? list[0].trace_id : null
  };
}

function broadcast(wss, type, data) {
  const encoded = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function sendSocket(socket, type, data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, data }));
}

function stateForLatency(eventName) {
  switch (eventName) {
    case 'cached_vision_ready': return 'Looking';
    case 'memory_context_ready': return 'Remembering';
    case 'model_dispatched':
    case 'first_response_chunk': return 'Thinking';
    case 'first_safe_public_text':
    case 'first_safe_sentence': return 'Responding';
    case 'tts_started':
    case 'tts_ready':
    case 'playback_started': return 'Speaking';
    default: return null;
  }
}

async function runChatRequest(wss, socket, requestId, text) {
  if (activeRequest) throw new Error('Floki is already responding; interrupt the active response first');
  const controller = new AbortController();
  activeRequest = { requestId, controller, state: 'Thinking', startedAt: nowMs() };
  sendSocket(socket, 'chat.state', { requestId, state: 'Thinking' });
  let releasedText = '';
  try {
    const result = await handleTypedText(runtimeInstance(), text, {
      signal: controller.signal,
      source: 'chat_local_interface',
      input_modality: 'text',
      output_modality: 'text',
      spoken_aloud: false,
      print_public_text: false,
      on_public_text(payload) {
        releasedText = String(payload && payload.text || '');
        sendSocket(socket, 'chat.token', { requestId, content: releasedText });
      },
      on_latency_event(event) {
        const state = stateForLatency(event.event);
        if (state && activeRequest) {
          activeRequest.state = state;
          sendSocket(socket, 'chat.state', { requestId, state });
        }
        sendSocket(socket, 'latency.trace', event);
        broadcast(wss, 'neural.event', latencyEventToNeural(event));
      }
    });
    const content = String(result.reply || releasedText || '');
    const latency = latencySummary(result.latency_events || []);
    sendSocket(socket, 'chat.latency', { requestId, latency });
    sendSocket(socket, 'chat.complete', { requestId, content, latency, traceId: result.trace_id });
  } catch (error) {
    const interrupted = controller.signal.aborted || error.name === 'AbortError';
    sendSocket(socket, interrupted ? 'chat.complete' : 'chat.error', interrupted
      ? { requestId, content: releasedText, interrupted: true, latency: null }
      : { requestId, error: error.message });
  } finally {
    activeRequest = null;
    sendSocket(socket, 'chat.state', { requestId, state: 'Idle' });
  }
}

function runScript(script, args = []) {
  const scriptPath = path.join(ROOT, 'bin', script);
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 360000
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `${script} failed`).trim());
  }
  return String(result.stdout || '').trim();
}

async function control(action, body = {}) {
  const normalized = String(action || '');
  if (normalized === 'interrupt') {
    if (!activeRequest) return { available: true, interrupted: false, message: 'No active response.' };
    activeRequest.controller.abort();
    return { available: true, interrupted: true, message: 'Active response interrupted.' };
  }
  if (normalized === 'pauseSleep') {
    return { available: true, message: runScript('floki-sleep-scheduler-stop.sh') };
  }
  if (normalized === 'resumeSleep') {
    return { available: true, message: runScript('floki-sleep-scheduler-start.sh') };
  }
  if (normalized === 'restartVision') {
    runScript('floki-chat-vision-stop.sh');
    return { available: true, message: runScript('floki-chat-vision-start.sh') };
  }
  if (normalized === 'restartHearing' || normalized === 'restartSpeech') {
    runScript('floki-chat-stop.sh');
    return { available: true, message: runScript('floki-chat-start.sh') };
  }
  if (normalized === 'restart-service') {
    const name = String(body.name || '');
    const mapping = {
      Vision: 'restartVision',
      Hearing: 'restartHearing',
      Speech: 'restartSpeech',
      'Sleep Scheduler': 'resumeSleep'
    };
    if (!mapping[name]) return { available: false, message: `${name || 'Service'} does not expose a safe restart action.` };
    return control(mapping[name], body);
  }
  const unavailable = {
    startChat: 'chat.local is already the active chat interface.',
    stopChat: 'Close the desktop window to stop chat.local safely.',
    restartChat: 'Close and relaunch chat.local to restart the complete interface.',
    wake: 'Wake state is driven by real user activity and the sleep-cycle subsystem.',
    requestSleep: 'Sleep transitions are owned by the sleep scheduler and configured sleep window.'
  };
  return { available: false, message: unavailable[normalized] || `Unknown control action: ${normalized}` };
}

const LOG_PATHS = Object.freeze({
  'Local API': statePath('chat/runtime/chat-local-api.log'),
  Vision: statePath('chat/runtime/chat-webcam-vision.log'),
  Hearing: statePath('chat/runtime/chat-mode-loop.log'),
  Speech: path.join(ROOT, '.floki-tools', 'output', 'spoken-reply-once', 'latest-spoken-reply-once.json'),
  'Sleep Scheduler': statePath('chat/runtime/sleep-cycle-scheduler.log')
});

async function handleHttp(request, response) {
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_API_HEALTH_PASS', pid: process.pid, node: process.version, root: ROOT, knowledgeAutoloadStatus });
    }
    if (request.method === 'GET' && url.pathname === '/api/status') return sendJson(response, 200, buildStatus());
    if (request.method === 'GET' && url.pathname === '/api/vision/frame') return sendJson(response, 200, buildVisionFrame());
    if (request.method === 'GET' && url.pathname === '/api/vision/observation') return sendJson(response, 200, buildObservation());
    if (request.method === 'GET' && url.pathname === '/api/emotions') return sendJson(response, 200, buildEmotion());
    if (request.method === 'GET' && url.pathname === '/api/sleep') return sendJson(response, 200, buildSleep());
    if (request.method === 'GET' && url.pathname === '/api/services') return sendJson(response, 200, buildServices());
    if (request.method === 'GET' && url.pathname === '/api/dreams/timeline') return sendJson(response, 200, buildDreamTimeline());
    if (request.method === 'GET' && url.pathname === '/api/neural/events') return sendJson(response, 200, buildNeuralEvents());
    if (request.method === 'GET' && url.pathname.startsWith('/api/logs/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/logs/'.length));
      const logPath = LOG_PATHS[name] || null;
      return sendJson(response, 200, { name, path: logPath, exists: Boolean(logPath && fs.existsSync(logPath)) });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/control/')) {
      const action = decodeURIComponent(url.pathname.slice('/api/control/'.length));
      const body = await readBody(request);
      return sendJson(response, 200, await control(action, body));
    }
    return sendJson(response, 404, { ok: false, error: 'Unknown Floki local API route' });
  } catch (error) {
    return sendJson(response, 500, { ok: false, error: error.message });
  }
}

function startServer() {
  const testNodeOverride = process.env.NODE_ENV === 'test' && process.env.FLOKI_CHAT_LOCAL_ALLOW_TEST_NODE === '1';
  if (!process.version.startsWith('v24.') && !testNodeOverride) {
    throw new Error(`Node 24 required for chat.local API, got ${process.version}`);
  }
  knowledgeAutoloadStatus = startKnowledgeAutoload();
  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });
  wss.on('connection', (socket) => {
    sendSocket(socket, 'status.update', buildStatus());
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); }
      catch (_error) { return sendSocket(socket, 'chat.error', { requestId: null, error: 'WebSocket message must be valid JSON' }); }
      const data = message && message.data || {};
      if (message.type === 'chat.send') {
        const requestId = String(data.requestId || '');
        const text = String(data.text || '').trim();
        if (!requestId || !text) return sendSocket(socket, 'chat.error', { requestId, error: 'requestId and non-empty text are required' });
        runChatRequest(wss, socket, requestId, text).catch((error) => sendSocket(socket, 'chat.error', { requestId, error: error.message }));
      } else if (message.type === 'chat.interrupt') {
        if (activeRequest && (!data.requestId || data.requestId === activeRequest.requestId)) activeRequest.controller.abort();
      }
    });
  });
  const statusTimer = setInterval(() => {
    broadcast(wss, 'status.update', buildStatus());
    broadcast(wss, 'vision.frame', buildVisionFrame());
    broadcast(wss, 'vision.observation', buildObservation());
    broadcast(wss, 'emotion.update', buildEmotion());
    broadcast(wss, 'sleep.update', buildSleep());
  }, 2000);
  server.on('close', () => clearInterval(statusTimer));
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_API_READY', host: HOST, port: PORT, pid: process.pid, root: ROOT }));
  });
  const shutdown = () => {
    clearInterval(statusTimer);
    for (const client of wss.clients) client.close(1001, 'chat.local API shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return { server, wss };
}

if (require.main === module) {
  try { startServer(); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_LOCAL_API_FAIL', error: error.message }));
    process.exit(1);
  }
}

module.exports = {
  ROOT,
  HOST,
  PORT,
  buildStatus,
  buildVisionFrame,
  buildObservation,
  buildEmotion,
  buildSleep,
  buildServices,
  buildDreamTimeline,
  buildNeuralEvents,
  latencySummary,
  latencyEventToNeural,
  control,
  startServer
};
