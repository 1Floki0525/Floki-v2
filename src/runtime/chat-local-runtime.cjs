'use strict';

const { readRawTerminal } = require('./raw-terminal-log.cjs');

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { createRuntime } = require('../chat/floki-chat.cjs');
const { handleTypedText } = require('../chat/floki-live-chat-interface.cjs');
const { createVisionReconciler } = require('./vision-reconciler.cjs');
const { appendChatTranscriptTurn, upsertChatTranscriptTurn, removeChatTranscriptTurn, appendPrivateThoughtRecord, readChatTranscriptTail, clearChatTranscript } = require('../chat/chat-transcript.cjs');
const { buildFlokiLifecycleStatus } = require('../chat/floki-lifecycle-status.cjs');
const {
  readChatWebcamVisionStatus,
  readLatestPrivateObservation,
  startChatWebcamVisionService,
  stopChatWebcamVisionService,
  runtimePaths: visionRuntimePaths
} = require('../vision/chat-webcam-vision-service.cjs');
const { createBrainEvent } = require('../brain/brain-event-schema.cjs');
const { createLiveAudioService } = require('../senses/live-audio-service.cjs');
const {
  PROJECT_ROOT: ROOT,
  getAudioConfig,
  getLiveChatConfig,
  getModelConfig,
  getPathConfig,
  getKnowledgeConfig,
  getSleepConfig,
  getVisionConfig,
  getControlPlaneConfig
} = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');
const { getInterfaceSettings } = require('../config/interface-settings.cjs');
const { readManualNapState, beginManualNap, wakeManualNap, claimDueRemCycle, finishRemCycle } = require('../chat/manual-nap.cjs');
const { recordWakeActivityIfSleeping, loadSleepCycleState } = require('../chat/sleep-cycle.cjs');
const { runDreamEngineOnce } = require('../chat/dream-engine.cjs');
const {
  readDreamEngineControl,
  writeDreamEngineControl
} = require('../chat/dream-engine-control.cjs');
const { createSelfImprovementApi } = require('../self-improvement/api.cjs');
const { loadSelfImprovementConfig } = require('../self-improvement/config.cjs');
const {
  evaluateNightlyPolicy
} = require('../self-improvement/nightly-policy.cjs');
const {
  createNightlyHfChatPostJson,
  nightlyHfModelConfig
} = require('../self-improvement/training/nightly-hf-chat.cjs');
const { reconcileDreamArchive } = require('../chat/dream-archive.cjs');
const { createChatLocalInterfaceApi } = require('./chat-local-interface-api.cjs');
const { createKnowledgeRuntimeBootstrap } = require('../chat/knowledge-runtime-bootstrap.cjs');
const { runPreRemMemoryPreparation } = require('../chat/pre-rem-memory-preparation.cjs');
const { assertApprovalToken } = require('../self-improvement/store.cjs');
const { enterTrainingRuntimeResourceMode, exitTrainingRuntimeResourceMode } = require('../self-improvement/training/runtime-resource-controller.cjs');
const { getModuleConfig, getRegistryMetadata, isKnownModule, IN_PROCESS_MODULES, SUPERVISED_MODULES } = require('../control-plane/module-registry.cjs');
const { buildAuthorizationHeader, parseAuthHeader, verifySignature } = require('../control-plane/sign-request.cjs');
const { controlClientApp, recordClientAppHeartbeat } = require('../control-plane/client-app-control.cjs');

const DEFAULT_HOST = getLiveChatConfig('chat').runtime_host;
const DEFAULT_PORT = getLiveChatConfig('chat').runtime_port;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, filePath);
}

function assertPortAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const client = net.connect({ host, port }, () => {
      client.destroy();
      reject(new Error('FLOKI_V2_CHAT_LOCAL_RUNTIME_PORT_IN_USE: ' + host + ':' + String(port) + ' is already in use'));
    });
    client.on('error', (error) => {
      if (error && error.code === 'ECONNREFUSED') {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function bodyJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('invalid JSON request: ' + error.message));
      }
    });
    req.on('error', reject);
  });
}

function bodyBuffer(req, maxBytes) {
  const limit = Math.max(1, Number(maxBytes || 0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        const error = new Error('request body too large');
        error.httpStatus = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseWavMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('remote voice upload must be a WAV file');
  }
  if (
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('remote voice upload must be RIFF/WAVE audio');
  }

  let offset = 12;
  let format = null;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      throw new Error('remote voice WAV chunk exceeds uploaded bytes');
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audio_format: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sample_rate: buffer.readUInt32LE(chunkStart + 4),
        byte_rate: buffer.readUInt32LE(chunkStart + 8),
        bits_per_sample: buffer.readUInt16LE(chunkStart + 14)
      };
    }
    if (chunkId === 'data') dataBytes = chunkSize;
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!format) throw new Error('remote voice WAV is missing a fmt chunk');
  if (format.audio_format !== 1) {
    throw new Error('remote voice WAV must use PCM audio');
  }
  if (format.channels < 1 || format.channels > 2) {
    throw new Error('remote voice WAV channel count is outside the supported bound');
  }
  if (format.byte_rate <= 0 || dataBytes <= 0) {
    throw new Error('remote voice WAV is missing audio samples');
  }
  const durationMs = Math.round(dataBytes / format.byte_rate * 1000);
  return Object.freeze({
    ...format,
    data_bytes: dataBytes,
    duration_ms: durationMs
  });
}

function validateRemoteVoiceUpload(buffer, contentType, audioConfig) {
  const expected = String(audioConfig.remote_voice_content_type || 'audio/wav').toLowerCase();
  const actual = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (![expected, 'audio/x-wav', 'application/octet-stream'].includes(actual)) {
    const error = new Error('remote voice upload must use ' + expected);
    error.httpStatus = 415;
    throw error;
  }
  const metadata = parseWavMetadata(buffer);
  const minMs = Number(audioConfig.remote_voice_min_duration_ms);
  const maxMs = Number(audioConfig.remote_voice_max_duration_ms);
  if (metadata.duration_ms < minMs) {
    const error = new Error('remote voice upload is shorter than the configured minimum duration');
    error.httpStatus = 422;
    throw error;
  }
  if (metadata.duration_ms > maxMs) {
    const error = new Error('remote voice upload exceeds the configured duration limit');
    error.httpStatus = 413;
    throw error;
  }
  return metadata;
}

function corsHeadersFor(req) {
  const origin = req && req.headers ? String(req.headers.origin || '') : '';
  const allowedOrigins = new Set([
    'http://127.0.0.1',
    'http://localhost',
    'https://galactic-family-hub.com'
  ]);
  const allowOrigin = allowedOrigins.has(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) ||
    /^http:\/\/localhost:\d+$/.test(origin)
    ? origin
    : 'http://127.0.0.1';
  return Object.freeze({
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...corsHeadersFor(res.req)
  });
  res.end(body);
}


async function jsonlFileSize(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function readJsonlActivityChunk(
  filePath,
  requestedCursor,
  options = {}
) {
  const source = String(options.source || 'activity');
  const plainTextFallback = options.plain_text_fallback === true;
  const maxBytes = Number(options.max_bytes);
  const maxEvents = Number(options.max_events);

  if (!Number.isInteger(maxBytes) || maxBytes < 4096) {
    throw new Error('activity stream max_bytes must be an integer >= 4096');
  }
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new Error('activity stream max_events must be a positive integer');
  }

  const size = await jsonlFileSize(filePath);
  const parsedCursor = Number(requestedCursor);
  let cursor = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0
    ? parsedCursor
    : 0;
  const cursorReset = cursor > size;
  if (cursorReset) cursor = 0;

  if (cursor >= size) {
    return Object.freeze({
      events: Object.freeze([]),
      next_cursor: cursor,
      file_size: size,
      cursor_reset: cursorReset
    });
  }

  const readLength = Math.min(maxBytes, size - cursor);
  const handle = await fs.promises.open(filePath, 'r');
  let bytesRead = 0;
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(readLength);
    ({ bytesRead } = await handle.read(
      buffer,
      0,
      readLength,
      cursor
    ));
  } finally {
    await handle.close();
  }

  const available = buffer.subarray(0, bytesRead);
  const reachedEof = cursor + bytesRead >= size;
  let completeBytes = bytesRead;

  if (available.length > 0 && available[available.length - 1] !== 0x0a) {
    const lastNewline = available.lastIndexOf(0x0a);
    completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  }

  if (!reachedEof && completeBytes === 0 && bytesRead === maxBytes) {
    throw new Error(
      'activity JSONL record exceeds activity_stream_max_bytes'
    );
  }

  const complete = available.subarray(0, completeBytes);
  const events = [];
  let lineStart = 0;
  let nextCursor = cursor;

  while (lineStart < complete.length && events.length < maxEvents) {
    const newline = complete.indexOf(0x0a, lineStart);
    if (newline < 0) break;

    let lineEnd = newline;
    if (lineEnd > lineStart && complete[lineEnd - 1] === 0x0d) {
      lineEnd -= 1;
    }

    const lineOffset = cursor + lineStart;
    const raw = complete.subarray(lineStart, lineEnd).toString('utf8');
    nextCursor = cursor + newline + 1;
    lineStart = newline + 1;

    if (!raw.trim()) continue;

    try {
      events.push({
        source,
        index: lineOffset,
        record: JSON.parse(raw)
      });
    } catch (_error) {
      events.push({
        source,
        index: lineOffset,
        record: plainTextFallback
          ? {
              type: 'sandbox_output',
              created_at: new Date().toISOString(),
              detail: { text: raw.slice(0, 12000) }
            }
          : {
              type: 'parse_error',
              raw: raw.slice(0, 200)
            }
      });
    }
  }

  return Object.freeze({
    events: Object.freeze(events),
    next_cursor: nextCursor,
    file_size: size,
    cursor_reset: cursorReset
  });
}

function filterActivityEventsForRun(events, currentRunId) {
  const runId = currentRunId ? String(currentRunId) : null;
  if (!runId) return [];
  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventRunId = event?.record?.detail?.run_id;
    return !eventRunId || String(eventRunId) === runId;
  });
}

function rsiRunIdFromLogFile(filePath, rsiConfig) {
  if (!filePath || !rsiConfig?.workspace_root) return null;
  const workspaceRoot = path.resolve(rsiConfig.workspace_root);
  const resolved = path.resolve(filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length >= 2 ? parts[0] : null;
}

async function safeExistingFileWithin(root, candidate) {
  if (!root || !candidate) return null;
  try {
    const rootPath = await fs.promises.realpath(path.resolve(root));
    const candidatePath = await fs.promises.realpath(path.resolve(candidate));
    const relative = path.relative(rootPath, candidatePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    const stat = await fs.promises.stat(candidatePath);
    return stat.isFile() ? candidatePath : null;
  } catch (_error) {
    return null;
  }
}

async function statExistingFileWithin(root, candidate) {
  const filePath = await safeExistingFileWithin(root, candidate);
  if (!filePath) return null;
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) return null;
  return Object.freeze({ filePath, stat });
}

function pipeFileResponse(res, source, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    res.once('error', fail);
    res.once('finish', finish);
    if (Buffer.isBuffer(source)) {
      res.writeHead(200, headers);
      res.end(source);
      return;
    }
    const stream = fs.createReadStream(source);
    stream.once('error', fail);
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

const FRAME_SNAPSHOT_MAX_ATTEMPTS = 4;
const FRAME_SNAPSHOT_RETRY_DELAY_MS = 40;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

async function readStableFrameSnapshot(filePath, maxBytes) {
  for (let attempt = 0; attempt < FRAME_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(FRAME_SNAPSHOT_RETRY_DELAY_MS);
    let handle = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size < 4 || before.size > maxBytes) continue;
      const buffer = Buffer.allocUnsafe(before.size);
      const { bytesRead } = await handle.read(buffer, 0, before.size, 0);
      const after = await handle.stat();
      const unchanged =
        bytesRead === before.size &&
        after.size === before.size &&
        Number(after.mtimeMs) === Number(before.mtimeMs);
      const completeJpeg =
        buffer[0] === JPEG_SOI[0] &&
        buffer[1] === JPEG_SOI[1] &&
        buffer[bytesRead - 2] === JPEG_EOI[0] &&
        buffer[bytesRead - 1] === JPEG_EOI[1];
      if (unchanged && completeJpeg) {
        return Object.freeze({ buffer, stat: after });
      }
    } catch (_error) {
      // Producer may be replacing the frame mid-attempt; retry within bounds.
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }
  return null;
}

function memoryPathsWritable() {
  const candidates = [
    path.join(ROOT, 'state/floki/memories'),
    path.join(ROOT, 'state/floki/chat/interface'),
    path.join(ROOT, 'state/floki')
  ];
  try {
    for (const dir of candidates) {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeIntentText(value) {
  const lower = String(value || '').toLowerCase();
  let out = '';
  let previousSpace = true;
  for (const character of lower) {
    const code = character.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 97 && code <= 122);
    if (alphaNumeric) {
      out += character;
      previousSpace = false;
    } else if (!previousSpace) {
      out += ' ';
      previousSpace = true;
    }
  }
  return out.trim();
}

function configuredVisionQuestionPhrases(visionConfig = getVisionConfig('chat')) {
  const configured = visionConfig && visionConfig.direct_question_phrases;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return [];
  return Object.values(configured)
    .map(normalizeIntentText)
    .filter(Boolean);
}

function looksLikeVisionQuestion(text, visionConfig = getVisionConfig('chat')) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return configuredVisionQuestionPhrases(visionConfig)
    .some((phrase) => normalized.includes(phrase));
}

function visionObservationTimestamp(visionContext) {
  if (!visionContext || typeof visionContext !== 'object') return null;
  return visionContext.latest_private_observation_timestamp ||
    visionContext.created_at ||
    visionContext.observed_at ||
    visionContext.timestamp ||
    null;
}

function configuredVisionHardwareQuestionPhrases(visionConfig = getVisionConfig('chat')) {
  const configured = visionConfig && visionConfig.vision_hardware_question_phrases;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return [];
  return Object.values(configured).map(normalizeIntentText).filter(Boolean);
}

function looksLikeVisionHardwareQuestion(text, visionConfig = getVisionConfig('chat')) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return configuredVisionHardwareQuestionPhrases(visionConfig).some((phrase) => normalized.includes(phrase));
}

function configuredProhibitedPublicVisionTerms(visionConfig = getVisionConfig('chat')) {
  const configured = visionConfig && visionConfig.prohibited_public_vision_terms;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return [];
  return Object.values(configured).map((value) => String(value || '').toLowerCase().trim()).filter(Boolean);
}

function toFirstPersonInnerExperience(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^(?:I|I'm|I’m|I've|I’ve|I'll|I’ll|My|Me)\b/i.test(text)) return text;
  text = text.replace(/^Floki\s+(?:is|was)\s+/i, 'I am ');
  if (/^I\b/i.test(text)) return text;
  return 'I am reflecting that ' + text.charAt(0).toLowerCase() + text.slice(1);
}

function encodeWebSocketText(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

async function waitForFreshVision(runtimeDir, options = {}) {
  const vision = getVisionConfig('chat');
  const maxAgeMs = Number(options.max_age_ms || vision.vision_question_max_age_ms);
  const waitMs = Number(options.wait_ms || vision.vision_question_wait_ms);
  const before = readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    max_age_ms: maxAgeMs
  });
  const beforeTimestamp = visionObservationTimestamp(before);
  const requestFile = path.join(runtimeDir, 'chat-webcam-vision.refresh-request.json');
  writeJsonAtomic(requestFile, {
    id: newId('visionrefresh'),
    requested_at: nowIso(),
    before_timestamp: beforeTimestamp,
    reason: options.reason || 'current_vision_question'
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const latest = readLatestPrivateObservation({
      runtime_dir: runtimeDir,
      max_age_ms: maxAgeMs
    });
    const timestamp = visionObservationTimestamp(latest);
    const age = timestamp ? Date.now() - new Date(timestamp).getTime() : Infinity;
    if (latest && latest.available === true && latest.fresh === true && age <= maxAgeMs && timestamp !== beforeTimestamp) {
      return latest;
    }
    await sleep(100);
  }
  return readLatestPrivateObservation({
    runtime_dir: runtimeDir,
    max_age_ms: maxAgeMs
  });
}

function createChatLocalRuntime(options = {}) {
  const paths = getPathConfig('chat');
  const runtimeDir = options.runtime_dir || path.resolve(ROOT, paths.chat_runtime_root);
  const pidFile = path.join(runtimeDir, 'chat-local-runtime.pid');
  const statusFile = path.join(runtimeDir, 'chat-local-runtime.status.json');
  const heartbeatFile = path.join(runtimeDir, 'chat-local-runtime.heartbeat.json');
  const logFile = path.join(runtimeDir, 'chat-local-runtime.log');
  const liveConfig = getLiveChatConfig('chat');
  const sleepConfig = getSleepConfig('chat');
  const host = options.host || liveConfig.runtime_host || DEFAULT_HOST;
  const port = Number(options.port || liveConfig.runtime_port || DEFAULT_PORT);
  const heartbeatMs = Number(liveConfig.runtime_heartbeat_ms);
  const lifecyclePollMs = Number(sleepConfig.lifecycle_status_poll_ms);
  const brain = options.runtime || createRuntime({ session_id: options.session_id || newId('chatruntime') });
  const reconcileArchive = options.reconcile_dream_archive || reconcileDreamArchive;
  const model = getModelConfig('chat').cognition;
  const audioConfig = getAudioConfig('chat');
  const visionConfig = getVisionConfig('chat');
  const selfImprovementApi = createSelfImprovementApi();
  const selfImprovementConfig =
    loadSelfImprovementConfig();
  const nightlyHfPostJson =
    createNightlyHfChatPostJson();
  const readLifecycleStatus =
    options.lifecycle_status_provider || buildFlokiLifecycleStatus;

  let server = null;
  let websocketClients = new Set();
  let stopping = false;
  let activeAbortController = null;
  let turnQueue = Promise.resolve();
  let lifecycle = readLifecycleStatus();
  let lifecycleTimer = null;
  let heartbeatTimer = null;
  let visionManagedSleeping = false;
  let manualNapDreamTask = null;
  let lastManualNapActive = false;
  const startedAt = Date.now();

  const state = {
    marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_STATUS',
    state: 'starting',
    started_at: nowIso(),
    last_heartbeat_at: null,
    last_error: null,
    brain_loaded: true,
    cognition_enabled: true,
    hearing_enabled: true,
    memory_enabled: true,
    emotion_enabled: true,
    live_event_stream_enabled: true,
    dream_engine_enabled:
      readDreamEngineControl({
        runtime_dir: runtimeDir
      }).enabled === true,
    memory_loaded: memoryPathsWritable(),
    active_turn: false,
    nightly_chat_active: false,
    active_cognition_provider: model.provider,
    active_cognition_model: model.model,
    last_turn_started_at: null,
    last_turn_completed_at: null,
    last_turn_modality: null,
    last_reply: '',
    api_ready: false,
    client_ready: false,
    window_visible: false,
    client_ready_at: null,
    client_detached_at: null,
    senses_enabled: false,
    shutdown_requested: false,
    hearing_start_error: null,
    vision_start_error: null,
    last_grounded_vision_reply_at: null,
    last_grounded_vision_source: null,
    last_grounded_vision_observation_at: null,
    last_grounded_vision_available: null,
    push_to_talk_active: false,
    websocket_ready: false,
    websocket_clients: 0,
    last_speech_final_transcript_at: null,
    last_chat_user_message_inserted_at: null,
    last_cognition_started_at: null,
    last_first_response_token_at: null,
    last_tts_started_at: null,
    last_microphone_closed_for_tts_at: null,
    last_microphone_reopened_at: null,
    last_microphone_fresh_pcm_at: null,
    knowledge_autoload: null,
    knowledge_ready: false,
    knowledge_refreshing: false,
    knowledge_refresh_error: null,
    knowledge_worker_started: false,
    knowledge_worker_running: false,
    camera_availability: true,
    vision_start_in_flight: false,
    vision_camera_stop_timeout_ms: Number(visionConfig.vision_camera_stop_timeout_ms || 10000),
    vision_camera_availability_probe_timeout_ms: Number(visionConfig.vision_camera_availability_probe_timeout_ms || 3000)
  };

  function appendLog(message) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.appendFileSync(logFile, '[' + nowIso() + '] ' + String(message || '') + '\n');
  }

  function broadcast(type, data) {
    if (
      state.live_event_stream_enabled !== true ||
      state.websocket_ready !== true
    ) {
      return;
    }
    const frame = encodeWebSocketText({ type, data });
    for (const socket of Array.from(websocketClients)) {
      if (socket.destroyed || !socket.writable) { websocketClients.delete(socket); continue; }
      try { socket.write(frame); } catch (error) { websocketClients.delete(socket); appendLog('websocket write failed: ' + error.message); }
    }
    state.websocket_clients = websocketClients.size;
  }

  function closeLiveEventStreamClients(reason) {
    const sockets = Array.from(websocketClients);
    for (const socket of sockets) {
      try {
        socket.end();
      } catch (error) {
        appendLog(
          'websocket close failed during ' +
          String(reason || 'stream lifecycle') +
          ': ' +
          error.message
        );
        try { socket.destroy(); } catch (_destroyError) {}
      }
    }
    websocketClients.clear();
    state.websocket_clients = 0;
    return sockets.length;
  }

  function appendInnerExperience(text, category, extra = {}) {
    const value = toFirstPersonInnerExperience(text);
    if (!value) return Object.freeze({ written: false, reason: 'empty_inner_experience' });
    const neuralSettings = getInterfaceSettings('chat').neuralStream;
    const written = appendPrivateThoughtRecord({
      text: value,
      category: category || 'reflection',
      severity: extra.severity || 'info',
      source: extra.source || 'chat_local_runtime',
      event_id: extra.event_id || null,
      session_id: brain.session_id,
      dedupe_window_ms: Number(neuralSettings.dedupeWindowMs || 0)
    });
    if (written.written) broadcast('inner-stream.entry', { id: written.entry.id, timestamp: Date.parse(written.entry.created_at), module: String(written.entry.category || 'reflection'), category: written.entry.category || 'reflection', summary: written.entry.text, severity: written.entry.severity || 'info' });
    return written;
  }

  function upsertSpokenTranscript(event) {
    const phase = event.phase === 'partial' ? 'partial' : 'final';
    const written = upsertChatTranscriptTurn({ id: 'speech-' + String(event.id), role: 'user', text: event.text, input_modality: 'spoken', output_modality: 'none', spoken_aloud: false, source: 'live_audio_service', transcript_state: phase });
    const insertedAt = nowIso();
    state.last_chat_user_message_inserted_at = insertedAt;
    if (phase === 'final') state.last_speech_final_transcript_at = event.transcribed_at || insertedAt;
    broadcast('transcript.entry', { ...written.entry, insertion_time: insertedAt });
    if (phase === 'final') appendInnerExperience('I hear the Maker asking, “' + String(event.text).replace(/[“”]/g, '') + '”', 'hearing', { source: 'live_audio_service' });
    publish();
    return written;
  }

  function status(extra = {}) {
    const audio = liveAudio.status();
    const vision = readChatWebcamVisionStatus({ runtime_dir: runtimeDir });
    lifecycle = readLifecycleStatus();
    const statusNightPolicy = evaluateNightlyPolicy(
      selfImprovementConfig,
      new Date()
    );
    const statusCognitionModel =
      statusNightPolicy.active === true
        ? nightlyHfModelConfig(
            selfImprovementConfig,
            model
          )
        : model;
    const sleeping = lifecycle && lifecycle.is_awake === false;
    const awaitingClient = state.client_ready !== true;
    const sensesAllowed = !sleeping;
    const hearingReady = Boolean(
      sensesAllowed &&
      state.hearing_enabled === true &&
      audio.microphone_open &&
      audio.vad_ready &&
      audio.whisper_ready &&
      audio.piper_ready &&
      audio.playback_ready &&
      !audio.last_error &&
      !audio.last_wake_gate_error &&
      !state.hearing_start_error
    );
    const visionReady = Boolean(
      sensesAllowed &&
      vision.ready_for_chat === true &&
      !state.vision_start_error
    );
    const degradedReasons = [];
    if (sensesAllowed && state.hearing_enabled === true && state.hearing_start_error) degradedReasons.push('hearing_start: ' + state.hearing_start_error);
    if (sensesAllowed && state.hearing_enabled === true && audio.last_error) degradedReasons.push('hearing_runtime: ' + audio.last_error);
    if (sensesAllowed && state.hearing_enabled === true && audio.last_wake_gate_error) degradedReasons.push('wake_gate: ' + audio.last_wake_gate_error);
    if (sensesAllowed && state.vision_start_error) degradedReasons.push('vision_start: ' + state.vision_start_error);
    const knowledgeRequired = state.memory_enabled === true && getKnowledgeConfig('chat').autoload_blocking_on_chat_local_start === true;
    if (knowledgeRequired && state.knowledge_refreshing) degradedReasons.push('knowledge_refreshing');
    if (knowledgeRequired && !state.knowledge_refreshing && state.knowledge_ready !== true) degradedReasons.push('knowledge_not_ready');
    if (knowledgeRequired && state.knowledge_refresh_error) degradedReasons.push('knowledge_refresh: ' + state.knowledge_refresh_error);
    if (sensesAllowed && state.hearing_enabled === true && !hearingReady && degradedReasons.length === 0) degradedReasons.push('hearing_not_ready');
    if (sensesAllowed && !visionReady && degradedReasons.length === 0) degradedReasons.push('vision_not_ready');
    const hearingSatisfied = state.hearing_enabled !== true || hearingReady;
    const sensoryReady = sleeping || (hearingSatisfied && visionReady);
    const ready = Boolean(
      state.api_ready &&
      state.brain_loaded &&
      state.cognition_enabled === true &&
      (state.memory_enabled !== true || state.memory_loaded === true) &&
      (!knowledgeRequired || state.knowledge_ready) &&
      sensoryReady &&
      !state.last_error &&
      degradedReasons.length === 0
    );
    return Object.freeze({
      ok: !state.last_error && (!sensesAllowed || degradedReasons.length === 0),
      ready,
      awaiting_client: awaitingClient,
      senses_allowed: sensesAllowed,
      hearing_ready: hearingReady,
      vision_ready: visionReady,
      hearing_intentionally_suspended: sleeping,
      vision_intentionally_suspended: sleeping,
      sensory_suspension_reason: sleeping ? 'sleeping' : null,
      degraded_reasons: degradedReasons,
      marker: state.marker,
      pid: process.pid,
      host,
      port,
      uptime_ms: Date.now() - startedAt,
      session_id: brain.session_id,
      cognition_model:
        statusCognitionModel.model,
      cognition_provider:
        statusCognitionModel.provider,
      nightly_hf_chat_available:
        statusNightPolicy.chat_available === true,
      mode: 'chat.local',
      ...state,
      lifecycle,
      hearing: audio,
      vision: {
        active: vision.active === true,
        ready: vision.ready_for_chat === true,
        camera_open: vision.camera_open === true,
        first_frame_received: vision.first_frame_received === true,
        latest_observation_at: vision.latest_private_observation_timestamp || null,
        last_error: vision.last_fatal_error || vision.last_vlm_error || vision.last_yolo_error || null
      },
      self_improvement: selfImprovementApi.status(),
      ...extra
    });
  }

  function publish(extra = {}) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    state.last_heartbeat_at = nowIso();
    const payload = status(extra);
    writeJsonAtomic(statusFile, payload);
    const heartbeat = { pid: process.pid, created_at: state.last_heartbeat_at, state: payload.state, ready: payload.ready };
    writeJsonAtomic(heartbeatFile, heartbeat);
    if (state.websocket_ready) broadcast('status.update', payload);
    return payload;
  }

  async function rememberAmbient(record) {
    if (state.memory_enabled !== true) {
      appendLog('ambient memory skipped: Memory module is stopped');
      return Object.freeze({
        type: 'memory_disabled',
        source: 'hippocampus',
        memory_written: false,
        reason: 'memory_module_stopped'
      });
    }
    const hippocampus = brain.requireModule('hippocampus');
    const summary = record.type === 'ambient_speech'
      ? 'I heard ambient speech nearby: ' + String(record.text || '').trim()
      : 'I heard ' + String(record.label || record.type || 'an ambient sound') + ' nearby.';
    const event = createBrainEvent({
      type: 'system_text',
      source: 'system',
      modality: 'text',
      created_at: record.captured_at || nowIso(),
      payload: {
        text: summary,
        sensory_modality: 'audio',
        source_type: record.source_type || 'ambient_unknown',
        addressed_to_floki: false,
        original_event_id: record.id || null
      },
      provenance: {
        observed_by: 'live_audio_service',
        confidence: typeof record.confidence === 'number' ? record.confidence : 0.65,
        notes: 'Live ambient hearing; not a direct user command.'
      }
    });
    const output = hippocampus.safeRememberEvent(event, {
      stream: 'short_term',
      type: 'experience',
      tags: ['audio', 'ambient', record.type || 'sound', record.source_type || 'unknown_source'],
      importance: record.type === 'ambient_speech' ? 0.35 : 0.25,
      content: {
        summary,
        detail: JSON.stringify({
          source_type: record.source_type || null,
          provenance: record.provenance || null,
          utterance_id: record.utterance_id || null,
          captured_at: record.captured_at || null
        })
      }
    });
    if (!output || output.type === 'failure') {
      const code = output && output.failure && output.failure.code || 'UNKNOWN';
      const message = output && output.failure && output.failure.message || 'ambient memory write failed';
      appendLog('ambient memory rejected: ' + code + ': ' + message);
      throw new Error(code + ': ' + message);
    }
    appendLog('ambient memory: ' + output.type);
    return output;
  }

  async function resolveVisionContext(text) {
    if (!looksLikeVisionQuestion(text, visionConfig)) return undefined;
    const readOptions = {
      runtime_dir: runtimeDir,
      max_age_ms: visionConfig.vision_question_max_age_ms
    };
    const current = readLatestPrivateObservation(readOptions);
    if (current && current.available === true && current.fresh === true) return current;
    return waitForFreshVision(runtimeDir, {
      reason: 'spoken_or_typed_vision_question',
      max_age_ms: visionConfig.vision_question_max_age_ms,
      wait_ms: visionConfig.vision_question_wait_ms
    });
  }

  function enqueueTurn(request) {
    const task = async () => {
      if (stopping) throw new Error('chat.local runtime is stopping');
      if (state.cognition_enabled !== true) {
        return cognitionUnavailableResult(
          request.source || 'chat_local_runtime'
        );
      }
      const nightlyPolicy = evaluateNightlyPolicy(
        selfImprovementConfig,
        new Date()
      );
      const nightlyHfChat = Boolean(
        nightlyPolicy.active === true &&
        nightlyPolicy.chat_available === true
      );
      const activeModelConfig = nightlyHfChat
        ? nightlyHfModelConfig(
            selfImprovementConfig,
            model
          )
        : model;
      if (!nightlyHfChat) {
        selfImprovementApi.preempt('foreground_user_turn');
      }
      state.nightly_chat_active = nightlyHfChat;
      state.active_cognition_provider =
        activeModelConfig.provider;
      state.active_cognition_model =
        activeModelConfig.model;
      state.active_turn = true;
      state.state = 'thinking';
      state.last_turn_started_at = nowIso();
      state.last_cognition_started_at = state.last_turn_started_at;
      appendInnerExperience('I am focusing on the Maker’s request: “' + String(request.cognition_text || '').replace(/[“”]/g, '').slice(0, 360) + '”', 'attention', { source: request.source || 'chat_local_runtime' });
      state.last_turn_modality = request.input_modality || 'text';
      activeAbortController = new AbortController();
      publish();
      try {
        const visionQuestion = looksLikeVisionQuestion(request.cognition_text, visionConfig);
        const visionHardwareQuestion = visionQuestion && looksLikeVisionHardwareQuestion(request.cognition_text, visionConfig);
        const visionContext = await resolveVisionContext(request.cognition_text);
        if (visionQuestion) {
          if (visionContext && visionContext.available === true) {
            const sceneThought = String(visionContext.scene_summary || visionContext.observation_summary || visionContext.grounding_summary || '').trim();
            if (sceneThought) appendInnerExperience('I notice ' + sceneThought.replace(/^I\s+(?:can\s+)?see\s+/i, '').replace(/[.]+$/, '') + '.', 'perception', { source: 'cognition_grounded_live_sight' });
          } else {
            appendInnerExperience('I notice that my sight is unavailable, so I need to answer honestly.', 'perception', { source: 'cognition_grounded_live_sight' });
          }
        }
        const result = await handleTypedText(brain, request.cognition_text, {
          model_config:
            nightlyHfChat
              ? activeModelConfig
              : undefined,
          streaming_enabled:
            nightlyHfChat ? false : undefined,
          post_json:
            nightlyHfChat
              ? nightlyHfPostJson
              : undefined,
          signal: activeAbortController.signal,
          memory_enabled: state.memory_enabled === true,
          emotion_enabled: state.emotion_enabled === true,
          input_modality: request.input_modality || 'text',
          output_modality: request.output_modality || 'text',
          spoken_aloud: request.spoken_aloud === true,
          source: request.source || 'chat_local_runtime',
          transcript_user_text: request.transcript_user_text || request.cognition_text,
          user_transcript_recorded: request.user_transcript_recorded === true,
          chat_webcam_vision: visionContext,
          vision_question: visionQuestion,
          vision_hardware_question: visionHardwareQuestion,
          print_public_text: false,
          on_first_chunk() { if (!state.last_first_response_token_at || state.last_first_response_token_at < state.last_turn_started_at) state.last_first_response_token_at = nowIso(); publish(); },
          on_inner_summary(summary) { appendInnerExperience(summary.text, summary.category || 'reflection', { source: request.source || 'chat_local_runtime', event_id: summary.event_id || null }); },
          on_transcript_entry(entry) { broadcast('transcript.entry', entry); }
        });
        if (!result || result.ok !== true) throw new Error(result && result.error || 'brain response failed');
        state.last_reply = result.reply || '';
        state.last_turn_completed_at = nowIso();
        if (visionQuestion) {
          state.last_grounded_vision_reply_at = state.last_turn_completed_at;
          state.last_grounded_vision_source = visionContext && visionContext.source || null;
          state.last_grounded_vision_observation_at = visionContext && visionContext.latest_private_observation_timestamp || null;
          state.last_grounded_vision_available = visionContext && visionContext.available === true;
          appendLog('cognition-grounded sight reply source=' + String(state.last_grounded_vision_source || 'unavailable') + ' observation_at=' + String(state.last_grounded_vision_observation_at || 'none'));
        }
        return result;
      } finally {
        activeAbortController = null;
        state.nightly_chat_active = false;
        state.active_cognition_provider =
          model.provider;
        state.active_cognition_model =
          model.model;
        state.active_turn = false;
        state.state = lifecycle.is_awake === false
          ? 'sleeping'
          : state.client_ready
            ? 'listening'
            : 'awaiting_client';
        publish();
      }
    };
    const scheduled = turnQueue.then(task, task);
    turnQueue = scheduled.then(() => undefined, (error) => { appendLog('queued turn failed: ' + error.message); return undefined; });
    return scheduled;
  }

  // Shutdown owns the full local vision teardown. Runtimes
  // constructed with a fake reconciler (tests) must never touch the real
  // vision daemon, so the default collapses to a no-op in that case.
  const visionShutdown = options.vision_shutdown || (options.vision_reconciler
    ? async () => null
    : (opts) => stopChatWebcamVisionService({ ...opts, runtime_dir: runtimeDir }));
  const visionReconciler = options.vision_reconciler || createVisionReconciler({
    readStatus: () => readChatWebcamVisionStatus({ runtime_dir: runtimeDir }),
    startService: (options) => startChatWebcamVisionService({ ...options, runtime_dir: runtimeDir }),
    stopService: (options) => stopChatWebcamVisionService({ ...options, runtime_dir: runtimeDir }),
    log: appendLog
  });

  const liveAudio = options.live_audio_service || createLiveAudioService({
    runtime_dir: runtimeDir,
    session_id: brain.session_id,
    audio_config: audioConfig,
    initial_awake: false,
    on_ambient_observation: rememberAmbient,
    on_transcript: upsertSpokenTranscript,
    on_transcript_discard(event) {
      const result = removeChatTranscriptTurn('speech-' + String(event.id));
      if (result.removed) broadcast('transcript.remove', { id: result.id });
      publish();
      return result;
    },
    on_cognition_start(event) { state.last_cognition_started_at = event.started_at || nowIso(); publish(); },
    on_tts_start(event) { state.last_tts_started_at = event.started_at || nowIso(); publish(); },
    on_microphone_lifecycle(event) {
      if (event.phase === 'closed_for_tts' && event.microphone_open === false) state.last_microphone_closed_for_tts_at = event.observed_at || nowIso();
      if (event.phase === 'reopened_after_tts' && event.microphone_open && event.speaking === false) state.last_microphone_reopened_at = event.reopened_at || event.observed_at || nowIso();
      if (event.fresh_pcm_received === true) state.last_microphone_fresh_pcm_at = event.observed_at || nowIso();
      publish();
    },
    async on_direct_speech(input) {
      if (state.cognition_enabled !== true) {
        return cognitionUnavailableResult('live_audio_service');
      }
      const acceptedAt = nowIso();
      const result = await enqueueTurn({
        cognition_text: input.request_text,
        transcript_user_text: input.raw_text,
        input_modality: 'spoken',
        output_modality: 'spoken',
        spoken_aloud: true,
        source: 'live_audio_service',
        user_transcript_recorded: true,
        transcript_id: input.transcript_id || input.utterance_id
      });
      appendLog('spoken turn ' + input.utterance_id + ' accepted_at=' + acceptedAt + ' completed_at=' + nowIso());
      return result;
    }
  });

  async function handleRemoteVoiceUtterance(req, res) {
    const voiceConfig = getAudioConfig('chat');
    if (voiceConfig.remote_voice_enabled !== true) {
      sendJson(res, 403, {
        ok: false,
        error: 'remote voice input is disabled by chat YAML',
        reason: 'remote_voice_disabled'
      });
      return;
    }
    const currentLifecycle = readLifecycleStatus();
    if (!currentLifecycle || currentLifecycle.is_awake !== true) {
      sendJson(res, 409, {
        ok: false,
        error: 'hearing is intentionally suspended while Floki is asleep',
        reason: 'sleeping'
      });
      return;
    }

    let upload;
    let wav;
    try {
      upload = await bodyBuffer(req, voiceConfig.remote_voice_max_bytes);
      wav = validateRemoteVoiceUpload(
        upload,
        req.headers['content-type'],
        voiceConfig
      );
    } catch (error) {
      sendJson(res, Number(error.httpStatus || 400), {
        ok: false,
        error: error.message,
        reason: error.httpStatus === 413
          ? 'remote_voice_upload_too_large'
          : 'remote_voice_upload_invalid'
      });
      return;
    }

    const utteranceId = newId('remotevoice');
    const tempDir = path.join(runtimeDir, 'audio-tmp', 'remote-voice');
    const inputFile = path.join(tempDir, utteranceId + '.wav');
    let replyAudioFile = null;
    try {
      fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(inputFile, upload, { mode: 0o600 });
      const parsed = await liveAudio.transcribeFile(inputFile, {
        source: 'remote_audio',
        utterance_id: utteranceId
      });
      const transcript = String(parsed.speech_text || '').trim();
      if (!transcript) {
        sendJson(res, 422, {
          ok: false,
          error: 'Whisper did not produce speech text from remote audio',
          reason: 'remote_voice_no_transcript',
          input_audio: wav
        });
        return;
      }
      if (transcript.length > Number(voiceConfig.remote_voice_transcript_max_chars)) {
        sendJson(res, 413, {
          ok: false,
          error: 'remote voice transcript exceeds the configured character limit',
          reason: 'remote_voice_transcript_too_large',
          transcript_length: transcript.length
        });
        return;
      }

      const result = await enqueueTurn({
        cognition_text: transcript,
        transcript_user_text: transcript,
        input_modality: 'spoken',
        output_modality: 'spoken',
        spoken_aloud: false,
        source: 'remote_audio'
      });
      if (!result || result.ok !== true) {
        sendJson(res, Number(result && result.httpStatus || 500), {
          ok: false,
          error: result && result.error || 'remote voice cognition failed',
          reason: 'remote_voice_cognition_failed',
          transcription: { text: transcript }
        });
        return;
      }

      const reply = String(result.reply || '').trim();
      let replyAudio = null;
      if (reply && voiceConfig.remote_voice_play_reply_audio === true) {
        if (!liveAudio || typeof liveAudio.synthesizeSpeech !== 'function') {
          throw new Error('Piper synthesis bridge is unavailable for remote voice');
        }
        const synthesis = await liveAudio.synthesizeSpeech(reply, {
          source: 'remote_audio',
          utterance_id: utteranceId,
          text_hash: 'remote_voice_' + String(reply.length)
        });
        replyAudioFile = synthesis.output_file;
        const audioBytes = await fs.promises.readFile(replyAudioFile);
        replyAudio = {
          content_type: 'audio/wav',
          base64: audioBytes.toString('base64'),
          size_bytes: audioBytes.length,
          voice_size: synthesis.voice_size || null,
          voice_name: synthesis.voice_name || null,
          playback_target: 'remote_client'
        };
      }

      sendJson(res, 200, {
        ok: true,
        marker: 'FLOKI_V2_REMOTE_VOICE_TO_WHISPER_PIPER_PASS',
        utterance_id: utteranceId,
        input_audio: wav,
        transcription: {
          text: transcript,
          raw_text: parsed.raw_text || '',
          source: 'host_whisper'
        },
        reply,
        reply_audio: replyAudio,
        cognition: {
          source: 'chat_local_runtime',
          latency_events: result.latency_events || []
        }
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message,
        reason: 'remote_voice_runtime_failure'
      });
    } finally {
      await fs.promises.rm(inputFile, { force: true }).catch(() => undefined);
      if (replyAudioFile) {
        await fs.promises.rm(replyAudioFile, { force: true }).catch(() => undefined);
      }
    }
  }

  const knowledgeBootstrap = options.knowledge_bootstrap || createKnowledgeRuntimeBootstrap({ runtime_dir: runtimeDir });
  const preRemMemoryPreparation = options.pre_rem_memory_preparation_runner || runPreRemMemoryPreparation;

  async function applyLifecycle(next) {
    // A reconcile that lands after shutdown begins must not respawn the
    // detached vision daemon or restart hearing; stop() owns teardown.
    if (stopping) return;
    lifecycle = next;
    const awake = next && next.is_awake === true;
    const voice = getInterfaceSettings('chat').voice;
    const vision = getVisionConfig('chat');
    const sleepOverrides = vision.sleep_overrides_vision_start !== false;
    const externalEyesEnabled = vision.external_eyes_enabled === true;
    const cameraAvailable = state.camera_availability !== false;
    // The reconciler owns duplicate-start suppression. This gate must not turn
    // desired vision off while an awake start is already in flight.
    const noActiveStart = true;
    const desiredGates = String(vision.desired_state_gates_required_for_start || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((gate) => gate !== 'client_ready' && gate !== 'window_visible');
    const gates = {
      awake: awake,
      inside_awake_window: awake || next.is_asleep !== true,
      external_eyes_enabled: externalEyesEnabled,
      policy_enabled: true,
      camera_available: cameraAvailable,
      no_active_start: noActiveStart
    };
    const allGatesPass = desiredGates.length === 0
      ? gates.awake
      : desiredGates.every((gate) => gates[gate] === true);
    const hearingEnabled = state.hearing_enabled === true && awake && voice.microphoneEnabled === true && (voice.pushToTalk === true ? state.push_to_talk_active === true : voice.handsFreeListening === true);
    const visionEnabled = awake && allGatesPass;
    state.senses_enabled = hearingEnabled || visionEnabled;

    try {
      await liveAudio.setAwake(hearingEnabled);
      state.hearing_start_error = null;
    } catch (error) {
      state.hearing_start_error = error.message;
      appendLog('hearing lifecycle reconcile failed: ' + error.message);
    }

    visionManagedSleeping = !visionEnabled && !awake;
    try {
      state.vision_start_in_flight = true;
      await visionReconciler.reconcile(visionEnabled, { awake });
      state.vision_start_error = null;
    } catch (error) {
      state.vision_start_error = error.message;
    } finally {
      state.vision_start_in_flight = false;
    }

    const audioStatus = liveAudio.status();
    state.state = !awake
      ? 'sleeping'
      : (state.hearing_start_error || state.vision_start_error || audioStatus.last_error || audioStatus.last_wake_gate_error)
          ? 'degraded'
          : state.active_turn
            ? 'thinking'
            : audioStatus.speaking
              ? 'speaking'
              : 'listening';
    publish();
  }

  async function requestManualNap() {
    if (typeof knowledgeBootstrap.stopAndWait === 'function') {
      await knowledgeBootstrap.stopAndWait();
    } else {
      knowledgeBootstrap.stop();
    }
    state.knowledge_worker_running = false;
    state.knowledge_refreshing = true;
    state.knowledge_refresh_error = null;
    publish();

    let preparation;
    try {
      preparation = await preRemMemoryPreparation({
        hippocampus_consolidation_runner: () =>
          brain.requireModule('hippocampus').consolidateShortTerm()
      });
      const refreshed = knowledgeBootstrap.inspect({ runtime_dir: runtimeDir });
      state.knowledge_ready = refreshed.ready === true;
      state.knowledge_autoload = Object.freeze({
        ...(preparation.autoload || {}),
        phase: 'complete',
        marker: preparation.autoload && preparation.autoload.marker ||
          'FLOKI_V2_PRE_REM_MEMORY_PREPARATION_PASS',
        source_count: Number(refreshed.source_count || preparation.source_count || 0),
        chunk_count: Number(refreshed.chunk_count || preparation.chunk_count || 0),
        knowledge_root: refreshed.knowledge_root || null,
        error: null
      });
      if (
        getKnowledgeConfig('chat').autoload_blocking_on_chat_local_start === true &&
        state.knowledge_ready !== true
      ) {
        throw new Error(
          'pre-REM knowledge index is not ready after ingestion and consolidation'
        );
      }
      state.knowledge_refresh_error = null;
      appendLog(
        'manual nap pre-REM memory preparation complete: scanned=' +
        String(preparation.scanned_file_count || 0) +
        ' new_sources=' +
        String(preparation.source_count || 0) +
        ' chunks=' +
        String(preparation.chunk_count || 0) +
        ' memories=' +
        String(preparation.memories_written || 0)
      );
    } catch (error) {
      state.knowledge_refresh_error = error && error.message
        ? error.message
        : String(error);
      appendLog(
        'manual nap pre-REM memory preparation failed: ' +
        state.knowledge_refresh_error
      );
      throw error;
    } finally {
      state.knowledge_refreshing = false;
      publish();
    }

    const nap = beginManualNap({
      consolidation: preparation,
      runtime_session_id: brain.session_id,
      replace_active: true
    });
    lastManualNapActive = true;
    await applyLifecycle(readLifecycleStatus());
    await processManualNap();
    const snapshot = status();
    const verified = snapshot.lifecycle.manual_nap_active === true &&
      snapshot.lifecycle.manual_nap_duration_minutes === sleepConfig.manual_nap_duration_minutes &&
      snapshot.hearing.microphone_open === false &&
      snapshot.vision.camera_open === false;
    appendInnerExperience(
      'I am settling into a nap and allowing the first REM cycle to begin.',
      'sleep',
      { source: 'manual_nap' }
    );
    return Object.freeze({
      ok: verified,
      verified,
      marker: verified
        ? 'FLOKI_V22_MANUAL_NAP_REQUEST_PASS'
        : 'FLOKI_V22_MANUAL_NAP_REQUEST_FAIL',
      nap,
      consolidation: preparation,
      status: snapshot
    });
  }
  function readSleepState() {
    try { return loadSleepCycleState() || null; } catch (_error) { return null; }
  }

  async function wakeFromManualNap() {
    const sleepState = readSleepState();
    const wasNightlySleeping = Boolean(sleepState && sleepState.active === true && sleepState.interrupted !== true);
    if (wasNightlySleeping) {
      try {
        const sleepResult = recordWakeActivityIfSleeping({ reason: 'control_wake_button' });
        appendLog('nightly sleep interrupted by Wake Floki control: ' + JSON.stringify(sleepResult));
      } catch (error) {
        appendLog('nightly sleep interrupt failed: ' + error.message);
      }
    }
    const nap = wakeManualNap('manual_wake'); lastManualNapActive = false; await applyLifecycle(readLifecycleStatus());
    return Object.freeze({
      ok: true,
      verified: true,
      marker: wasNightlySleeping ? 'FLOKI_V22_NIGHTLY_WAKE_PASS' : 'FLOKI_V22_MANUAL_NAP_WAKE_PASS',
      interrupted_nightly_sleep: wasNightlySleeping,
      nap,
      status: status()
    });
  }
  async function processManualNap() {
    const nap = readManualNapState();
    if (!nap || nap.active !== true) { if (lastManualNapActive) { lastManualNapActive = false; await applyLifecycle(readLifecycleStatus()); } return; }
    lastManualNapActive = true;
    if (manualNapDreamTask) return;
    const dreamControl = readDreamEngineControl({
      runtime_dir: runtimeDir
    });
    state.dream_engine_enabled =
      dreamControl.enabled === true;
    if (state.dream_engine_enabled !== true) {
      publish({
        dream_generation_suspended: true,
        dream_engine_control_reason:
          dreamControl.reason || null
      });
      return;
    }
    const claim = claimDueRemCycle();
    if (!claim) return;
    appendInnerExperience('I am entering REM cycle ' + String(claim.cycle.cycle_number) + ' and beginning a dream.', 'dream', { source: 'manual_nap' });
    manualNapDreamTask = runDreamEngineOnce({ sleep_kind: 'manual_nap', env: { ...process.env, FLOKI_ALLOW_DREAM_ENGINE: '1' }, rem_cycle_number: claim.cycle.cycle_number, sleep_window_start: claim.state.started_at, sleep_window_end: claim.state.wake_at }).then((result) => finishRemCycle(result, null)).catch((error) => {
      const message = error && error.message ? error.message : String(error);
      finishRemCycle(null, error);
      if (message.startsWith('DREAM_QUALITY_CONTRACT_REJECTED_AFTER_')) {
        appendLog('manual nap REM quality regeneration continuing: ' + message);
      } else {
        appendLog('manual nap REM architecture error: ' + message);
      }
    }).finally(async () => { manualNapDreamTask = null; await applyLifecycle(readLifecycleStatus()); });
  }


  function restartKnowledgeAfterTraining() {
    if (state.memory_enabled !== true) {
      state.knowledge_worker_started = false;
      state.knowledge_worker_running = false;
      state.knowledge_refreshing = false;
      return Object.freeze({
        started: false,
        reason: 'memory_module_stopped'
      });
    }
    const configured = getKnowledgeConfig('chat');
    if (configured.autoload_enabled !== true) {
      state.knowledge_worker_started = false;
      state.knowledge_worker_running = false;
      state.knowledge_refreshing = false;
      return Object.freeze({ started: false, reason: 'disabled_by_chat_yaml' });
    }
    if (knowledgeBootstrap.running()) {
      return Object.freeze({ started: false, reason: 'already_running' });
    }
    const launch = knowledgeBootstrap.start({
      runtime_dir: runtimeDir,
      on_update(update) {
        state.knowledge_refreshing = update.phase === 'refreshing';
        state.knowledge_worker_running = update.phase === 'refreshing';
        state.knowledge_refresh_error = update.error || null;
        state.knowledge_ready = update.ready === true;
        const existing = update.existing || {};
        state.knowledge_autoload = Object.freeze({
          ...(update.result || {}),
          phase: update.phase,
          marker: update.marker,
          source_count: Number(
            existing.source_count ||
            (update.result && update.result.source_count) ||
            0
          ),
          chunk_count: Number(
            existing.chunk_count ||
            (update.result && update.result.chunk_count) ||
            0
          ),
          knowledge_root:
            existing.knowledge_root ||
            (update.result && update.result.knowledge_root) ||
            null,
          error: update.error || null
        });
        appendLog(
          'knowledge autoload ' + String(update.phase) + ': ' +
          String(update.marker) + ' sources=' +
          String(state.knowledge_autoload.source_count || 0) +
          ' chunks=' +
          String(state.knowledge_autoload.chunk_count || 0) +
          (update.error ? ' error=' + String(update.error) : '')
        );
        publish();
      }
    });
    state.knowledge_worker_started = launch.started === true;
    state.knowledge_worker_running = launch.started === true;
    return Object.freeze({
      started: launch.started === true,
      reason: launch.reason || null
    });
  }

  async function enterTrainingResource(body = {}) {
    const config = loadSelfImprovementConfig();
    assertApprovalToken(body.token, config);
    if (state.active_turn === true) throw new Error('cannot enter training resource mode during an active foreground turn');
    if (liveAudio.status().speaking === true) throw new Error('cannot enter training resource mode while speech output is active');
    selfImprovementApi.preempt('exclusive_training_resource_transition');
    state.training_resource_mode = 'entering';
    state.training_resource_error = null;
    publish();
    try {
      const result = await enterTrainingRuntimeResourceMode({
        config,
        run_id: String(body.run_id || ''),
        reason: 'manual_or_nightly_training',
        liveAudio,
        visionReconciler,
        knowledgeBootstrap,
        restartKnowledge: restartKnowledgeAfterTraining,
        applyLifecycle,
        buildLifecycle: readLifecycleStatus
      });
      state.training_resource_mode = 'active';
      state.training_resource_entered_at = result.entered_at;
      state.training_resource_error = null;
      state.gpu_owner = result.gpu_owner;
      state.training_scheduler_restart_required = result.scheduler_restart_required === true;
      state.knowledge_worker_running = false;
      publish();
      return { ok: true, verified: true, result, status: status() };
    } catch (error) {
      state.training_resource_mode = 'failed';
      state.training_resource_error = error.message;
      publish();
      throw error;
    }
  }

  async function exitTrainingResource(body = {}) {
    const config = loadSelfImprovementConfig();
    assertApprovalToken(body.token, config);
    state.training_resource_mode = 'restoring';
    state.training_resource_error = null;
    publish();
    const result = await exitTrainingRuntimeResourceMode({
      config,
      reason: String(body.reason || 'training_finished'),
      liveAudio,
      restartKnowledge: restartKnowledgeAfterTraining,
      restart_scheduler: state.training_scheduler_restart_required === true,
      applyLifecycle,
      buildLifecycle: readLifecycleStatus
    });
    state.training_resource_mode = result.ok ? 'idle' : 'failed';
    state.training_resource_error = result.ok ? null : JSON.stringify(result.failures);
    state.training_resource_restored_at = result.completed_at;
    state.gpu_owner = null;
    state.training_scheduler_restart_required = false;
    publish();
    if (!result.ok) throw new Error('training runtime restoration failed: ' + JSON.stringify(result.failures));
    return { ok: true, verified: true, result, status: status() };
  }

  const interfaceApi = createChatLocalInterfaceApi({ runtime_dir: runtimeDir, status, started_at: startedAt, session_id: brain.session_id });

  function controlPlaneConfig() {
    return getControlPlaneConfig('chat');
  }

  function supervisorRequestOptions(moduleKey, action, body = {}) {
    const config = controlPlaneConfig();
    const privateKeyPath = config.supervisor_private_key_path || process.env.FLOKI_CONTROL_PLANE_PRIVATE_KEY_PATH;
    if (!privateKeyPath) {
      throw new Error('supervisor_private_key_path not configured');
    }
    const expanded = String(privateKeyPath).replace(/^~(?=\/)/, process.env.HOME || '');
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(ROOT, expanded);
    if (!fs.existsSync(resolved)) {
      throw new Error('supervisor private key not found: ' + resolved);
    }
    const privateKey = fs.readFileSync(resolved, 'utf8').trim();
    const signed = buildAuthorizationHeader(privateKey, 'POST', moduleKey, action, JSON.stringify(body || {}));
    return {
      transport: 'signed_ed25519_tcp',
      host: config.supervisor_host,
      port: config.supervisor_port,
      path: '/modules/' + moduleKey + '/' + action,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: signed.header
      },
      timeout: Number(config.supervisor_operation_timeout_ms || 360000)
    };
  }

  function supervisorLifecycleRequest(moduleKey, action, body = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const options = supervisorRequestOptions(moduleKey, action, body);
      const transport = options.transport || 'signed_ed25519_tcp';
      const reqBody = JSON.stringify(body || {});
      const req = http.request(options, (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            const parsed = JSON.parse(raw);
            resolve(Object.freeze({
              ...(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'invalid supervisor response' }),
              httpStatus: Number(response.statusCode || 0),
              transport
            }));
          } catch (_error) {
            resolve({ ok: false, error: 'invalid supervisor response', httpStatus: 502, transport });
          }
        });
      });
      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: error.message, httpStatus: 503, transport });
      });
      req.on('timeout', () => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolve({ ok: false, error: 'supervisor request timed out', httpStatus: 504, transport });
      });
      req.write(reqBody);
      req.end();
    });
  }


  function cognitionUnavailableResult(source = 'chat_local_runtime') {
    const error = 'Cognition is stopped; start Cognition before submitting a turn.';
    return Object.freeze({
      ok: false,
      module: 'cognition',
      changed: false,
      previousStatus: 'stopped',
      status: 'stopped',
      lifecycleState: 'stopped',
      error,
      safeError: error,
      message: error,
      source,
      httpStatus: 503,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        cognition_enabled: false
      }),
      operationId: newId('op'),
      generation: 1
    });
  }

  function cognitionIdleRuntimeState() {
    return lifecycle && lifecycle.is_awake === false
      ? 'sleeping'
      : 'listening';
  }

  async function cognitionLifecycleResult(action) {
    const previousStatus =
      state.cognition_enabled === true ? 'running' : 'stopped';
    let changed = false;
    let message;

    if (action === 'stop') {
      changed = state.cognition_enabled === true;
      state.cognition_enabled = false;
      if (activeAbortController) {
        activeAbortController.abort();
      }
      state.state = 'cognition_stopped';
      message = changed
        ? 'Cognition stopped inside the authoritative runtime.'
        : 'Cognition is already stopped.';
    } else if (action === 'start') {
      changed = state.cognition_enabled !== true;
      state.cognition_enabled = true;
      state.state = cognitionIdleRuntimeState();
      message = changed
        ? 'Cognition started inside the authoritative runtime.'
        : 'Cognition is already running.';
    } else if (action === 'reset') {
      if (activeAbortController) {
        activeAbortController.abort();
      }
      state.cognition_enabled = false;
      state.state = 'cognition_stopped';
      publish();
      await Promise.resolve();
      state.cognition_enabled = true;
      state.state = cognitionIdleRuntimeState();
      changed = true;
      message =
        'Cognition reset completed inside the authoritative runtime.';
    } else {
      return unsupportedInProcessLifecycleResult('cognition', action);
    }

    const currentStatus =
      state.cognition_enabled === true ? 'running' : 'stopped';
    appendLog(
      'control-plane cognition ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' changed=' + String(changed)
    );
    const snapshot = publish();

    return Object.freeze({
      ok: true,
      module: 'cognition',
      action,
      changed,
      previousStatus,
      status: currentStatus,
      lifecycleState: currentStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        cognition_enabled: state.cognition_enabled === true,
        runtime_ready: snapshot.ready === true
      }),
      message,
      safeError: null,
      httpStatus: 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  function hearingActivationRequired() {
    const voice = getInterfaceSettings('chat').voice;
    const awake = lifecycle && lifecycle.is_awake === true;
    return Boolean(
      state.hearing_enabled === true &&
      awake &&
      voice.microphoneEnabled === true &&
      (
        voice.pushToTalk === true
          ? state.push_to_talk_active === true
          : voice.handsFreeListening === true
      )
    );
  }

  function currentHearingLifecycleStatus(audioStatus = liveAudio.status()) {
    if (state.hearing_enabled !== true) return 'stopped';
    if (!hearingActivationRequired()) return 'stopped';
    if (
      audioStatus.microphone_open === true &&
      audioStatus.vad_ready === true &&
      audioStatus.whisper_ready === true &&
      !audioStatus.last_error &&
      !audioStatus.last_wake_gate_error &&
      !state.hearing_start_error
    ) {
      return 'running';
    }
    return 'degraded';
  }

  async function hearingLifecycleResult(action) {
    const beforeAudio = liveAudio.status();
    const previousStatus = currentHearingLifecycleStatus(beforeAudio);
    const previousEnabled = state.hearing_enabled === true;
    let changed = false;
    let message;

    if (action === 'stop') {
      changed = previousEnabled;
      state.hearing_enabled = false;
      state.hearing_start_error = null;
      await liveAudio.setAwake(false);
      await applyLifecycle(readLifecycleStatus());
      message = changed
        ? 'Hearing stopped through the authoritative live-audio service.'
        : 'Hearing is already stopped.';
    } else if (action === 'start') {
      changed = !previousEnabled;
      state.hearing_enabled = true;
      state.hearing_start_error = null;
      await applyLifecycle(readLifecycleStatus());
      message = hearingActivationRequired()
        ? 'Hearing started through the authoritative live-audio service.'
        : 'Hearing is enabled and waiting for the existing awake and voice-setting gates.';
    } else if (action === 'reset') {
      state.hearing_enabled = false;
      state.hearing_start_error = null;
      await liveAudio.setAwake(false);
      await applyLifecycle(readLifecycleStatus());
      state.hearing_enabled = true;
      await applyLifecycle(readLifecycleStatus());
      changed = true;
      message = hearingActivationRequired()
        ? 'Hearing reset completed through the authoritative live-audio service.'
        : 'Hearing reset completed and remains gated until the existing awake and voice-setting conditions are satisfied.';
    } else {
      return unsupportedInProcessLifecycleResult('hearing', action);
    }

    const audioStatus = liveAudio.status();
    const activationRequired = hearingActivationRequired();
    const currentStatus = currentHearingLifecycleStatus(audioStatus);
    const operationError = activationRequired && currentStatus !== 'running'
      ? (
          state.hearing_start_error ||
          audioStatus.last_error ||
          audioStatus.last_wake_gate_error ||
          'Hearing activation was required but the microphone pipeline did not become ready'
        )
      : null;

    appendLog(
      'control-plane hearing ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' + String(state.hearing_enabled === true) +
      ' activation_required=' + String(activationRequired) +
      ' changed=' + String(changed)
    );
    publish();

    return Object.freeze({
      ok: operationError === null,
      module: 'hearing',
      action,
      changed,
      previousStatus,
      status: operationError ? 'degraded' : currentStatus,
      lifecycleState: operationError ? 'degraded' : currentStatus,
      health: Object.freeze({
        ok: operationError === null,
        pid: process.pid,
        runtime_pid_preserved: true,
        hearing_enabled: state.hearing_enabled === true,
        activation_required: activationRequired,
        client_ready: state.client_ready === true,
        client_presence_is_telemetry_only: true,
        awake: lifecycle && lifecycle.is_awake === true,
        microphone_open: audioStatus.microphone_open === true,
        vad_ready: audioStatus.vad_ready === true,
        whisper_ready: audioStatus.whisper_ready === true,
        service_state: audioStatus.service_state
      }),
      message,
      error: operationError,
      safeError: operationError,
      httpStatus: operationError ? 503 : 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  function speechActivationRequired() {
    const voice = getInterfaceSettings('chat').voice;
    return Boolean(
      lifecycle &&
      lifecycle.is_awake === true &&
      voice.speakerEnabled === true
    );
  }

  function currentSpeechLifecycleStatus(audioStatus = liveAudio.status()) {
    if (audioStatus.speech_enabled !== true) return 'stopped';
    if (!speechActivationRequired()) return 'stopped';
    if (
      audioStatus.piper_ready === true &&
      audioStatus.playback_ready === true
    ) {
      return 'running';
    }
    return 'degraded';
  }

  async function speechLifecycleResult(action) {
    const beforeAudio = liveAudio.status();
    const previousStatus = currentSpeechLifecycleStatus(beforeAudio);
    const previousEnabled = beforeAudio.speech_enabled === true;
    let changed = false;
    let message;

    if (action === 'stop') {
      const stopped = liveAudio.setSpeechEnabled(false);
      changed = stopped.speech_control_changed === true;
      message = changed
        ? 'Speech stopped through the authoritative Piper output gate.'
        : 'Speech is already stopped.';
    } else if (action === 'start') {
      const started = liveAudio.setSpeechEnabled(true);
      changed = started.speech_control_changed === true;
      message = speechActivationRequired()
        ? 'Speech started through the authoritative Piper output gate.'
        : 'Speech is enabled and waiting for the existing awake and speaker-setting gates.';
    } else if (action === 'reset') {
      liveAudio.setSpeechEnabled(false);
      liveAudio.setSpeechEnabled(true);
      changed = true;
      message = speechActivationRequired()
        ? 'Speech reset completed through the authoritative Piper output gate.'
        : 'Speech reset completed and remains gated until the existing activation conditions are satisfied.';
    } else {
      return unsupportedInProcessLifecycleResult('speech', action);
    }

    const audioStatus = liveAudio.status();
    const activationRequired = speechActivationRequired();
    const currentStatus = currentSpeechLifecycleStatus(audioStatus);
    const operationError = (
      action !== 'stop' &&
      activationRequired &&
      currentStatus !== 'running'
    )
      ? 'Speech activation was required but Piper playback is not ready'
      : null;

    appendLog(
      'control-plane speech ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' + String(audioStatus.speech_enabled === true) +
      ' activation_required=' + String(activationRequired) +
      ' changed=' + String(changed) +
      ' previous_enabled=' + String(previousEnabled)
    );
    publish();

    return Object.freeze({
      ok: operationError === null,
      module: 'speech',
      action,
      changed,
      previousStatus,
      status: operationError ? 'degraded' : currentStatus,
      lifecycleState: operationError ? 'degraded' : currentStatus,
      health: Object.freeze({
        ok: operationError === null,
        pid: process.pid,
        runtime_pid_preserved: true,
        speech_enabled: audioStatus.speech_enabled === true,
        activation_required: activationRequired,
        awake: lifecycle && lifecycle.is_awake === true,
        piper_ready: audioStatus.piper_ready === true,
        playback_ready: audioStatus.playback_ready === true,
        speaking: audioStatus.speaking === true
      }),
      message,
      error: operationError,
      safeError: operationError,
      httpStatus: operationError ? 503 : 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  function inspectPersistentMemory() {
    const existing = knowledgeBootstrap.inspect({
      runtime_dir: runtimeDir
    });
    state.memory_loaded = memoryPathsWritable();
    state.knowledge_ready = existing.ready === true ||
      getKnowledgeConfig('chat').autoload_enabled !== true;
    state.knowledge_refresh_error = existing.error || null;
    state.knowledge_autoload = Object.freeze({
      ...existing,
      phase: state.memory_enabled === true
        ? 'ready_or_pending_refresh'
        : 'memory_stopped',
      marker: existing.marker
    });
    return existing;
  }

  async function memoryLifecycleResult(action) {
    const previousEnabled = state.memory_enabled === true;
    const previousStatus = previousEnabled
      ? (state.memory_loaded === true ? 'running' : 'degraded')
      : 'stopped';
    let changed = false;
    let message;

    if (action === 'stop') {
      changed = previousEnabled;
      state.memory_enabled = false;
      if (typeof knowledgeBootstrap.stopAndWait === 'function') {
        await knowledgeBootstrap.stopAndWait();
      } else {
        knowledgeBootstrap.stop();
      }
      state.knowledge_worker_started = false;
      state.knowledge_worker_running = false;
      state.knowledge_refreshing = false;
      state.knowledge_refresh_error = null;
      message = changed
        ? 'Memory stopped; persistent writes, recall, living continuity, ambient memory, and knowledge refresh are disabled.'
        : 'Memory is already stopped.';
    } else if (action === 'start') {
      changed = !previousEnabled;
      state.memory_enabled = true;
      inspectPersistentMemory();
      restartKnowledgeAfterTraining();
      message = changed
        ? 'Memory started using the existing persistent state and knowledge index.'
        : 'Memory is already running.';
    } else if (action === 'reset') {
      state.memory_enabled = false;
      if (typeof knowledgeBootstrap.stopAndWait === 'function') {
        await knowledgeBootstrap.stopAndWait();
      } else {
        knowledgeBootstrap.stop();
      }
      state.knowledge_worker_started = false;
      state.knowledge_worker_running = false;
      state.knowledge_refreshing = false;
      state.memory_enabled = true;
      inspectPersistentMemory();
      restartKnowledgeAfterTraining();
      changed = true;
      message = 'Memory reset completed without deleting or clearing persistent state.';
    } else {
      return unsupportedInProcessLifecycleResult('memory', action);
    }

    const currentStatus = state.memory_enabled !== true
      ? 'stopped'
      : state.memory_loaded === true
        ? 'running'
        : 'degraded';
    const operationError = (
      state.memory_enabled === true &&
      state.memory_loaded !== true
    )
      ? 'Persistent memory paths are not readable and writable'
      : null;

    appendLog(
      'control-plane memory ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' + String(state.memory_enabled === true) +
      ' worker_running=' + String(state.knowledge_worker_running === true) +
      ' changed=' + String(changed)
    );
    publish();

    return Object.freeze({
      ok: operationError === null,
      module: 'memory',
      action,
      changed,
      previousStatus,
      status: operationError ? 'degraded' : currentStatus,
      lifecycleState: operationError ? 'degraded' : currentStatus,
      health: Object.freeze({
        ok: operationError === null,
        pid: process.pid,
        runtime_pid_preserved: true,
        memory_enabled: state.memory_enabled === true,
        memory_loaded: state.memory_loaded === true,
        knowledge_ready: state.knowledge_ready === true,
        knowledge_worker_running:
          state.knowledge_worker_running === true,
        knowledge_refreshing:
          state.knowledge_refreshing === true
      }),
      message,
      error: operationError,
      safeError: operationError,
      httpStatus: operationError ? 503 : 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  async function emotionLifecycleResult(action) {
    const previousEnabled = state.emotion_enabled === true;
    const previousStatus = previousEnabled ? 'running' : 'stopped';
    let changed = false;
    let message;

    if (action === 'stop') {
      changed = previousEnabled;
      state.emotion_enabled = false;
      message = changed
        ? 'Emotion stopped; affect and reinforcement updates are frozen without clearing existing emotional state.'
        : 'Emotion is already stopped.';
    } else if (action === 'start') {
      changed = !previousEnabled;
      state.emotion_enabled = true;
      message = changed
        ? 'Emotion started using the existing persistent affect and reinforcement state.'
        : 'Emotion is already running.';
    } else if (action === 'reset') {
      state.emotion_enabled = false;
      await Promise.resolve();
      state.emotion_enabled = true;
      changed = true;
      message = 'Emotion reset completed without clearing or overwriting existing emotional state.';
    } else {
      return unsupportedInProcessLifecycleResult('emotion', action);
    }

    const currentStatus =
      state.emotion_enabled === true ? 'running' : 'stopped';

    appendLog(
      'control-plane emotion ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' + String(state.emotion_enabled === true) +
      ' changed=' + String(changed)
    );
    publish();

    return Object.freeze({
      ok: true,
      module: 'emotion',
      action,
      changed,
      previousStatus,
      status: currentStatus,
      lifecycleState: currentStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        emotion_enabled: state.emotion_enabled === true,
        affect_state_preserved: true,
        reinforcement_state_preserved: true
      }),
      message,
      error: null,
      safeError: null,
      httpStatus: 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  async function liveEventStreamLifecycleResult(action) {
    const previousEnabled =
      state.live_event_stream_enabled === true;
    const previousStatus = (
      previousEnabled &&
      state.websocket_ready === true
    )
      ? 'running'
      : 'stopped';
    let changed = false;
    let disconnectedClients = 0;
    let message;

    if (action === 'stop') {
      changed = previousEnabled || state.websocket_ready === true;
      state.live_event_stream_enabled = false;
      state.websocket_ready = false;
      disconnectedClients =
        closeLiveEventStreamClients('control-plane stop');
      message = changed
        ? 'Live Event Stream stopped; WebSocket delivery is disabled and connected clients were closed.'
        : 'Live Event Stream is already stopped.';
    } else if (action === 'start') {
      changed = !previousEnabled || state.websocket_ready !== true;
      state.live_event_stream_enabled = true;
      state.websocket_ready = state.api_ready === true;
      message = state.websocket_ready === true
        ? 'Live Event Stream started and is accepting WebSocket clients.'
        : 'Live Event Stream is enabled and waiting for the Authoritative API listener.';
    } else if (action === 'reset') {
      state.live_event_stream_enabled = false;
      state.websocket_ready = false;
      disconnectedClients =
        closeLiveEventStreamClients('control-plane reset');
      publish();
      await Promise.resolve();
      state.live_event_stream_enabled = true;
      state.websocket_ready = state.api_ready === true;
      changed = true;
      message = state.websocket_ready === true
        ? 'Live Event Stream reset completed; clients may reconnect.'
        : 'Live Event Stream reset completed and is waiting for the Authoritative API listener.';
    } else {
      return unsupportedInProcessLifecycleResult(
        'live_event_stream',
        action
      );
    }

    const currentStatus = (
      state.live_event_stream_enabled === true &&
      state.websocket_ready === true
    )
      ? 'running'
      : 'stopped';

    appendLog(
      'control-plane live_event_stream ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' +
      String(state.live_event_stream_enabled === true) +
      ' disconnected_clients=' +
      String(disconnectedClients) +
      ' changed=' + String(changed)
    );
    publish();

    return Object.freeze({
      ok: true,
      module: 'live_event_stream',
      action,
      changed,
      previousStatus,
      status: currentStatus,
      lifecycleState: currentStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        live_event_stream_enabled:
          state.live_event_stream_enabled === true,
        websocket_ready: state.websocket_ready === true,
        websocket_clients: state.websocket_clients,
        disconnected_clients: disconnectedClients,
        authoritative_api_ready: state.api_ready === true
      }),
      message,
      error: null,
      safeError: null,
      httpStatus: 200,
      operationId: newId('op'),
      generation: 1
    });
  }


  function schedulerDreamGateObservation(control) {
    let schedulerPid = null;
    try {
      const value = Number(
        fs.readFileSync(
          path.join(
            runtimeDir,
            'sleep-cycle-scheduler.pid'
          ),
          'utf8'
        ).trim()
      );
      if (Number.isInteger(value) && value > 0) {
        process.kill(value, 0);
        schedulerPid = value;
      }
    } catch (_error) {
      schedulerPid = null;
    }

    const heartbeat = jsonFile(
      path.join(
        runtimeDir,
        'sleep-cycle-scheduler.heartbeat.json'
      ),
      null
    ) || {};
    const observedGeneration =
      Number.isInteger(heartbeat.dream_engine_generation)
        ? heartbeat.dream_engine_generation
        : null;
    const observedEnabled =
      typeof heartbeat.dream_engine_enabled === 'boolean'
        ? heartbeat.dream_engine_enabled
        : null;
    const observationCurrent =
      observedGeneration !== null &&
      observedGeneration >= Number(control.generation) &&
      observedEnabled === (control.enabled === true);

    return Object.freeze({
      scheduler_running: schedulerPid !== null,
      scheduler_pid: schedulerPid,
      observed_generation: observedGeneration,
      observed_enabled: observedEnabled,
      observation: observationCurrent ? 'current' : 'pending'
    });
  }

  async function dreamEngineLifecycleResult(action) {
    if (!['start', 'stop', 'reset'].includes(action)) {
      return unsupportedInProcessLifecycleResult(
        'dream_engine',
        action
      );
    }

    const before = readDreamEngineControl({
      runtime_dir: runtimeDir
    });
    const previousStatus =
      before.enabled === true ? 'running' : 'stopped';
    const desiredEnabled = action !== 'stop';
    const changed =
      action === 'reset' ||
      (before.enabled === true) !== desiredEnabled;

    writeDreamEngineControl(desiredEnabled, {
      runtime_dir: runtimeDir,
      reason: 'control_plane_' + action
    });
    const current = readDreamEngineControl({
      runtime_dir: runtimeDir
    });

    const persisted =
      !current.read_error &&
      current.enabled === desiredEnabled &&
      Number(current.generation) > Number(before.generation);

    if (!persisted) {
      const error =
        'Dream Engine ' + action +
        ' control record did not persist atomically' +
        (current.read_error
          ? ': ' + current.read_error
          : '');
      appendLog(
        'control-plane dream_engine ' + action +
        ' failed: ' + error
      );
      return Object.freeze({
        ok: false,
        module: 'dream_engine',
        action,
        changed: false,
        previousStatus,
        status: 'degraded',
        lifecycleState: 'degraded',
        health: Object.freeze({
          ok: false,
          pid: process.pid,
          runtime_pid_preserved: true,
          dream_engine_enabled: current.enabled === true,
          control_persisted: false,
          control_file: current.control_file
        }),
        message: error,
        error,
        safeError: error,
        httpStatus: 500,
        operationId: newId('op'),
        generation: Number(before.generation) || 0
      });
    }

    state.dream_engine_enabled = current.enabled === true;
    const schedulerObservation =
      schedulerDreamGateObservation(current);
    const currentStatus =
      current.enabled === true ? 'running' : 'stopped';
    let message;
    if (action === 'stop') {
      message = changed
        ? 'Dream Engine stopped; new REM dream claims are suspended and due cycles remain pending.'
        : 'Dream Engine stop re-persisted the disabled control record; due cycles remain pending.';
    } else if (action === 'start') {
      message = changed
        ? 'Dream Engine started; pending REM cycles become eligible on the next normal scheduler iteration.'
        : 'Dream Engine start re-persisted the enabled control record.';
    } else {
      message =
        'Dream Engine reset completed; the control generation advanced and dreams, sleep state, and pending REM cycles were preserved.';
    }

    appendLog(
      'control-plane dream_engine ' + action +
      ' previous=' + previousStatus +
      ' current=' + currentStatus +
      ' enabled=' + String(current.enabled === true) +
      ' generation=' + String(current.generation) +
      ' scheduler_observation=' +
      schedulerObservation.observation +
      ' changed=' + String(changed)
    );
    publish({
      dream_engine_control: current,
      dream_engine_scheduler_observation:
        schedulerObservation
    });

    return Object.freeze({
      ok: true,
      module: 'dream_engine',
      action,
      changed,
      previousStatus,
      status: currentStatus,
      lifecycleState: currentStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        dream_engine_enabled: current.enabled === true,
        control_persisted: true,
        control_generation: Number(current.generation),
        control_file: current.control_file,
        active_manual_nap_generation:
          manualNapDreamTask !== null,
        scheduler_running:
          schedulerObservation.scheduler_running,
        scheduler_pid: schedulerObservation.scheduler_pid,
        scheduler_observation:
          schedulerObservation.observation,
        scheduler_observed_generation:
          schedulerObservation.observed_generation,
        dreams_preserved: true,
        sleep_state_preserved: true,
        pending_rem_cycles_preserved: true
      }),
      message,
      error: null,
      safeError: null,
      httpStatus: 200,
      operationId: newId('op'),
      generation: Number(current.generation)
    });
  }

  async function clientAppLifecycleResult(moduleKey, action, body = {}) {
    let controlled;
    try {
      controlled = controlClientApp(moduleKey, action, { runtime_dir: runtimeDir });
    } catch (error) {
      return Object.freeze({
        ok: false,
        module: moduleKey,
        action,
        error: error.message,
        safeError: String(error.message || error).slice(0, 500),
        httpStatus: error.httpStatus || 400
      });
    }

    if (action === 'stop' || action === 'reset') {
      closeLiveEventStreamClients('client-app ' + moduleKey + ' ' + action);
    }

    const app = controlled.current;
    const operationStatus = app.enabled === true ? 'running' : 'stopped';
    const healthStatus = app.status;
    const explicitControlReason =
      body &&
      Object.prototype.hasOwnProperty.call(body, 'reason') &&
      String(body.reason || '').trim().length > 0;
    const responseStatus = explicitControlReason
      ? operationStatus
      : healthStatus;

    appendLog(
      'control-plane ' + moduleKey + ' ' + action +
      ' previous=' + controlled.previousStatus +
      ' current=' + responseStatus +
      ' operation=' + operationStatus +
      ' health=' + healthStatus +
      ' enabled=' + String(app.enabled === true) +
      ' generation=' + String(app.control_generation) +
      ' clients=' + String(app.connected_client_count) +
      ' healthy_clients=' + String(app.healthy_client_count) +
      ' changed=' + String(controlled.changed)
    );
    publish();

    return Object.freeze({
      ok: true,
      module: moduleKey,
      action,
      changed: controlled.changed,
      previousStatus: controlled.previousStatus,
      status: responseStatus,
      lifecycleState: responseStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: true,
        client_app: true,
        enabled: app.enabled === true,
        status: healthStatus,
        client_presence: app.client_presence || 'idle',
        connection_required_for_health:
          app.connection_required_for_health === true,
        connected_client_count: app.connected_client_count,
        healthy_client_count: app.healthy_client_count,
        stale_client_count: app.stale_client_count,
        last_heartbeat_at: app.last_heartbeat_at,
        connected_since: app.connected_since,
        session_uptime_ms: app.session_uptime_ms,
        transport_type: app.transport_type,
        last_reported_error: app.last_reported_error,
        heartbeat_fresh_ms: app.heartbeat_fresh_ms,
        control_generation: app.control_generation,
        recovery_heartbeat_path_available: true
      }),
      message:
        moduleKey + ' ' + action +
        ' accepted by the authoritative client-app control service.',
      error: null,
      safeError: null,
      httpStatus: 200,
      operationId: newId('op'),
      generation: app.control_generation
    });
  }

  function unsupportedInProcessLifecycleResult(moduleKey, action) {
    const module = getModuleConfig(moduleKey);
    const currentStatus = module.status;
    const error =
      module.name + ' ' + action +
      ' is not yet implemented as a real module-specific operation';

    return Object.freeze({
      ok: false,
      module: moduleKey,
      action,
      changed: false,
      previousStatus: currentStatus,
      status: currentStatus,
      lifecycleState: currentStatus,
      health: Object.freeze({
        ok: true,
        pid: process.pid,
        runtime_pid_preserved: module.preserve_runtime_pid
      }),
      message: error + '; no state was changed.',
      error,
      safeError: error,
      httpStatus: 501,
      operationId: newId('op'),
      generation: 1
    });
  }

async function waitForRsiWorkerState(expectedRunning, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let latest = selfImprovementApi.status();
    while (Date.now() < deadline) {
      latest = selfImprovementApi.status();
      const pid = Number(latest.worker_pid || 0);
      let pidAlive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); pidAlive = true; } catch (_error) { pidAlive = false; }
      }
      if (expectedRunning === true && latest.worker_running === true && pidAlive) {
        return Object.freeze({ verified: true, status: latest, pid_alive: true });
      }
      if (expectedRunning === false && latest.worker_running !== true && !pidAlive) {
        return Object.freeze({ verified: true, status: latest, pid_alive: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return Object.freeze({ verified: false, status: latest, pid_alive: false });
  }

  function runRsiControlScript(name) {
    const file = path.join(ROOT, 'bin', name);
    if (!fs.existsSync(file)) {
      throw new Error('RSI control script is missing: ' + file);
    }
    const scriptTimeout = Number(controlPlaneConfig().supervisor_operation_timeout_ms || 120000);
    const result = spawnSync('bash', [file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: scriptTimeout,
      maxBuffer: 4 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        name + ' failed: ' +
        String(result.stderr || result.stdout || 'status=' + String(result.status)).trim()
      );
    }
    return Object.freeze({
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || '')
    });
  }

  async function stopRsiAuthoritatively(reason = 'system_rsi_stop') {
    const config = loadSelfImprovementConfig();
    const {
      abortNightlyTrainingSession,
      readNightlySession
    } = require('../self-improvement/training/nightly-training-session.cjs');
    const gpu = require('../self-improvement/training/gpu-ownership.cjs');
    const session = readNightlySession(config);
    let trainingAbort = null;
    if (session && session.active === true && session.finalized !== true) {
      trainingAbort = abortNightlyTrainingSession(session, { config, reason });
    }
    selfImprovementApi.preempt(reason);
    const script = runRsiControlScript('floki-self-improvement-stop.sh');
    const owner = gpu.currentOwner(config);
    if (owner === 'hf_training' || owner === 'hf_rem_inference') {
      gpu.release(owner, config);
    }
    const verification = await waitForRsiWorkerState(false);
    const latest = selfImprovementApi.status();
    const verified = verification.verified === true &&
      !latest.current_container &&
      !latest.current_run_id &&
      (!trainingAbort || trainingAbort.verified === true);
    return Object.freeze({
      ok: verified,
      verified,
      marker: verified
        ? 'FLOKI_V2_RSI_SYSTEM_STOP_VERIFIED'
        : 'FLOKI_V2_RSI_SYSTEM_STOP_FAILED',
      module: 'rsi',
      action: 'stop',
      script,
      training_abort: trainingAbort,
      status: latest,
      error: verified ? null : 'RSI worker or active workload remained after stop'
    });
  }

  async function rsiLifecycleResult(action) {
    if (action === 'stop') return stopRsiAuthoritatively('system_rsi_stop');
    if (action === 'reset') {
      const stopped = await stopRsiAuthoritatively('system_rsi_restart');
      if (stopped.verified !== true) return stopped;
      const script = runRsiControlScript('floki-self-improvement-start.sh');
      const verification = await waitForRsiWorkerState(true);
      return Object.freeze({
        ok: verification.verified === true,
        verified: verification.verified === true,
        marker: verification.verified === true
          ? 'FLOKI_V2_RSI_SYSTEM_RESTART_VERIFIED'
          : 'FLOKI_V2_RSI_SYSTEM_RESTART_FAILED',
        module: 'rsi',
        action: 'restart',
        script,
        status: verification.status,
        error: verification.verified === true ? null : 'RSI worker did not become live after restart'
      });
    }
    if (action === 'start') {
      const before = selfImprovementApi.status();
      const pid = Number(before.worker_pid || 0);
      if (before.worker_running === true && pid > 0) {
        try {
          process.kill(pid, 0);
          return Object.freeze({
            ok: true,
            verified: true,
            marker: 'FLOKI_V2_RSI_SYSTEM_ALREADY_RUNNING',
            module: 'rsi',
            action: 'start',
            status: before
          });
        } catch (_error) { /* stale status; run the real start script */ }
      }
      const script = runRsiControlScript('floki-self-improvement-start.sh');
      const verification = await waitForRsiWorkerState(true);
      return Object.freeze({
        ok: verification.verified === true,
        verified: verification.verified === true,
        marker: verification.verified === true
          ? 'FLOKI_V2_RSI_SYSTEM_START_VERIFIED'
          : 'FLOKI_V2_RSI_SYSTEM_START_FAILED',
        module: 'rsi',
        action: 'start',
        script,
        status: verification.status,
        error: verification.verified === true ? null : 'RSI worker did not become live after start'
      });
    }
    return Object.freeze({
      ok: false,
      verified: false,
      module: 'rsi',
      action,
      error: 'unsupported RSI lifecycle action: ' + String(action),
      httpStatus: 400
    });
  }

  async function moduleLifecycle(moduleKey, action, body = {}) {
    if (moduleKey === 'rsi') return rsiLifecycleResult(action);
    if (!isKnownModule(moduleKey)) {
      return Object.freeze({ ok: false, error: 'unknown module key' });
    }
    if (!['start', 'stop', 'reset'].includes(action)) {
      return Object.freeze({ ok: false, error: 'unknown action' });
    }

    const module = getModuleConfig(moduleKey);
    if (SUPERVISED_MODULES.has(moduleKey)) {
      try {
        return await supervisorLifecycleRequest(moduleKey, action, body);
      } catch (error) {
        return Object.freeze({
          ok: false,
          module: moduleKey,
          action,
          error: error.message,
          safeError: String(error.message || error).slice(0, 500),
          httpStatus: 503
        });
      }
    }

    if (moduleKey === 'cognition') {
      return cognitionLifecycleResult(action);
    }

    if (moduleKey === 'hearing') {
      return hearingLifecycleResult(action);
    }

    if (moduleKey === 'speech') {
      return speechLifecycleResult(action);
    }

    if (moduleKey === 'memory') {
      return memoryLifecycleResult(action);
    }

    if (moduleKey === 'emotion') {
      return emotionLifecycleResult(action);
    }

    if (moduleKey === 'live_event_stream') {
      return liveEventStreamLifecycleResult(action);
    }

    if (moduleKey === 'dream_engine') {
      return dreamEngineLifecycleResult(action);
    }

    if (moduleKey === 'web_app' || moduleKey === 'mobile_app') {
      return clientAppLifecycleResult(moduleKey, action, body);
    }

    if (IN_PROCESS_MODULES.has(moduleKey)) {
      return unsupportedInProcessLifecycleResult(moduleKey, action);
    }

    return Object.freeze({ ok: false, error: 'module lifecycle type unknown' });
  }

  function runControlScript(script) {
    const scriptPath = path.join(ROOT, 'bin', script);
    const result = spawnSync('bash', [scriptPath], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 360000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || script + ' failed').trim());
    return String(result.stdout || '').trim();
  }

  async function restartLiveAudio(label) {
    const awake = lifecycle && lifecycle.is_awake === true;
    await liveAudio.stop();
    await liveAudio.start();
    await liveAudio.setAwake(awake);
    const audioStatus = liveAudio.status();
    const verified = awake
      ? audioStatus.microphone_open === true && audioStatus.service_state === 'listening'
      : audioStatus.microphone_open === false;
    if (!verified) throw new Error(label + ' restart did not restore the expected microphone lifecycle');
    await applyLifecycle(readLifecycleStatus());
    return { ok: true, verified: true, message: label + ' restarted through the authoritative chat.local runtime.', status: audioStatus };
  }

  async function controlAction(action, body = {}) {
    if (action === 'startChat') {
      const current = status();
      return { ok: current.api_ready === true, verified: current.api_ready === true, message: 'The authoritative chat.local runtime is already running.', status: current };
    }
    if (action === 'stopChat') {
      setTimeout(() => { void stop().catch((error) => appendLog('runtime stop control failed: ' + error.message)); }, 50);
      return { ok: true, verified: true, message: 'Authoritative chat.local shutdown accepted.' };
    }
    if (action === 'restartChat') {
      setTimeout(() => {
        void (async () => {
          await stop({ skipPidDeletion: true });
          stopping = false;
          state.shutdown_requested = false;
          await start();
        })().catch((error) => {
          state.last_error = 'runtime restart control failed: ' + error.message;
          appendLog(state.last_error);
        });
      }, 50);
      return { ok: true, verified: true, message: 'Authoritative chat.local restart accepted.' };
    }
    if (action === 'interrupt') { const hadTurn = Boolean(activeAbortController); if (activeAbortController) activeAbortController.abort(); const speech = await liveAudio.interruptSpeech(); return { ok: true, verified: hadTurn || speech.interrupted === true, interrupted: hadTurn || speech.interrupted === true, speech }; }
    if (action === 'requestSleep') return requestManualNap();
    if (action === 'wake') return wakeFromManualNap();
    if (action === 'pauseSleep' || action === 'pauseAutoSleep') return { ok: true, verified: true, message: runControlScript('floki-sleep-scheduler-stop.sh') };
    if (action === 'resumeSleep' || action === 'restartScheduler') return { ok: true, verified: true, message: runControlScript('floki-sleep-scheduler-start.sh') };
    if (action === 'restartVision') { runControlScript('floki-chat-vision-stop.sh'); return { ok: true, verified: true, message: runControlScript('floki-chat-vision-start.sh') }; }
    if (action === 'restartHearing') return restartLiveAudio('Hearing');
    if (action === 'restartSpeech') return restartLiveAudio('Speech');
    return { ok: false, verified: false, available: false, error: 'Unknown chat.local control: ' + String(action || '') };
  }

  async function route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeadersFor(req)
      });
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://' + host + ':' + String(port));
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      sendJson(res, 200, status());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/transcript') {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 200)));
      sendJson(res, 200, { ok: true, entries: readChatTranscriptTail(limit) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/interface/status') { sendJson(res, 200, interfaceApi.buildInitialStatus()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/services') { sendJson(res, 200, interfaceApi.buildServices()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/transcript') { const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 200))); sendJson(res, 200, interfaceApi.getTranscript(limit)); return; }
    if (req.method === 'GET' && url.pathname === '/interface/vision/frame') { sendJson(res, 200, interfaceApi.buildVisionFrame()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/vision/frame/base64') { sendJson(res, 200, { data: interfaceApi.latestFrameBase64() }); return; }
    if (req.method === 'GET' && url.pathname === '/interface/vision/observation') { sendJson(res, 200, interfaceApi.buildObservation()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/emotion') { sendJson(res, 200, interfaceApi.buildEmotion()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/emotion/history') { sendJson(res, 200, interfaceApi.buildAffectHistory(Number(url.searchParams.get('limit') || 360))); return; }
    if (req.method === 'GET' && url.pathname === '/interface/sleep') { sendJson(res, 200, interfaceApi.buildSleep()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/neural') { sendJson(res, 200, interfaceApi.buildNeuralEvents(Number(url.searchParams.get('limit') || 250))); return; }
    if (req.method === 'GET' && url.pathname === '/interface/dreams') { sendJson(res, 200, interfaceApi.buildDreamTimeline()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/settings') { sendJson(res, 200, interfaceApi.getSettings()); return; }
    if (req.method === 'GET' && url.pathname === '/interface/coverage') { sendJson(res, 200, interfaceApi.coverage()); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/interface/log/')) { sendJson(res, 200, interfaceApi.logPath(decodeURIComponent(url.pathname.slice('/interface/log/'.length)))); return; }
    if (req.method === 'GET' && url.pathname === '/control/modules') {
      const cardRows = interfaceApi.buildServices();
      sendJson(res, 200, { ok: true, registry: getRegistryMetadata(), cards: cardRows });
      return;
    }
    const lifecycleMatch = req.method === 'POST' && url.pathname.match(/^\/control\/modules\/([a-z_][a-z0-9_]*)\/(start|stop|reset)$/);
    if (lifecycleMatch) {
      const moduleKey = lifecycleMatch[1];
      const action = lifecycleMatch[2];
      const body = await bodyJson(req);
      const result = await moduleLifecycle(moduleKey, action, body);
      const upstreamStatus = Number(result.httpStatus || 0);
      const safeStatus = result.ok
        ? 200
        : (result.error === 'unknown module key' || result.error === 'unknown action')
          ? 404
          : [400, 401, 403, 404, 409, 423, 429, 501, 502, 503, 504].includes(upstreamStatus)
            ? upstreamStatus
            : 400;
      sendJson(res, safeStatus, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interface/client-app/heartbeat') {
      const body = await bodyJson(req, 64 * 1024);
      try {
        const app = recordClientAppHeartbeat(body, { runtime_dir: runtimeDir });
        sendJson(res, 200, { ok: true, app, status: app.status, generation: app.control_generation });
      } catch (error) {
        sendJson(res, error.httpStatus || 400, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interface/settings/update') { const body = await bodyJson(req); const settings = interfaceApi.updateSettings(String(body.section || ''), body.values || {}); await applyLifecycle(readLifecycleStatus()); sendJson(res, 200, settings); return; }
    if (req.method === 'POST' && url.pathname === '/interface/settings/reset') { const body = await bodyJson(req); const settings = interfaceApi.resetSettings(body.section == null ? null : String(body.section)); await applyLifecycle(readLifecycleStatus()); sendJson(res, 200, settings); return; }
    if (req.method === 'POST' && url.pathname === '/interface/settings/import') { const body = await bodyJson(req); const settings = interfaceApi.importSettings(body.settings || {}); await applyLifecycle(readLifecycleStatus()); sendJson(res, 200, settings); return; }
    if (req.method === 'POST' && url.pathname.startsWith('/interface/control/')) { const action = decodeURIComponent(url.pathname.slice('/interface/control/'.length)); const body = await bodyJson(req); sendJson(res, 200, await controlAction(action, body)); return; }
    if (req.method === 'POST' && url.pathname === '/client-ready') {
      state.client_ready = true;
      state.window_visible = true;
      state.client_ready_at = nowIso();
      state.client_detached_at = null;
      appendLog('interface ready; reconciling awake sensory services');
      await applyLifecycle(readLifecycleStatus());
      sendJson(res, 200, { ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_CLIENT_READY_PASS', status: status() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/client-detached') {
      state.client_ready = false;
      state.window_visible = false;
      state.client_detached_at = nowIso();
      appendLog('interface detached; suspending external senses');
      await applyLifecycle(readLifecycleStatus());
      sendJson(res, 200, { ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_CLIENT_DETACHED_PASS', status: status() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/transcript/clear') {
      const result = clearChatTranscript();
      appendLog('visible chat transcript cleared; entries=' + String(result.entries_cleared));
      sendJson(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await bodyJson(req);
      const text = String(body.text || '').trim();
      if (!text) throw new Error('message text is required');
      if (state.cognition_enabled !== true) {
        const unavailable = cognitionUnavailableResult('electron_chat');
        sendJson(res, unavailable.httpStatus, unavailable);
        return;
      }
      const result = await enqueueTurn({
        cognition_text: text,
        transcript_user_text: text,
        input_modality: 'text',
        output_modality: 'text',
        spoken_aloud: false,
        source: 'electron_chat'
      });
      sendJson(res, Number(result.httpStatus || 200), result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') { sendJson(res, 200, await controlAction('interrupt')); return; }
    if (req.method === 'POST' && url.pathname === '/nap/request') { sendJson(res, 200, await requestManualNap()); return; }
    if (req.method === 'POST' && url.pathname === '/nap/wake') { sendJson(res, 200, await wakeFromManualNap()); return; }
    if (req.method === 'GET' && url.pathname === '/nap/status') { sendJson(res, 200, { ok: true, nap: readManualNapState(), lifecycle: readLifecycleStatus() }); return; }
	    if (req.method === 'POST' && url.pathname === '/settings/reload') { await applyLifecycle(readLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, settings: getInterfaceSettings('chat'), status: status() }); return; }
	    if (req.method === 'POST' && url.pathname === '/audio/remote-utterance') { await handleRemoteVoiceUtterance(req, res); return; }
	    if (req.method === 'POST' && url.pathname === '/audio/push-to-talk') { const body = await bodyJson(req); state.push_to_talk_active = body.active === true; await applyLifecycle(readLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, active: state.push_to_talk_active, status: status() }); return; }
    if (req.method === 'POST' && url.pathname === '/self-improvement/training-resource/enter') {
      const body = await bodyJson(req);
      sendJson(res, 200, await enterTrainingResource(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/training-resource/exit') {
      const body = await bodyJson(req);
      sendJson(res, 200, await exitTrainingResource(body));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/self-improvement/status') {
      sendJson(res, 200, { ok: true, status: selfImprovementApi.status() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/self-improvement/candidates') {
      sendJson(res, 200, { ok: true, candidates: selfImprovementApi.listCandidates() });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/self-improvement/candidates/')) {
      const id = decodeURIComponent(url.pathname.slice('/self-improvement/candidates/'.length));
      sendJson(res, 200, { ok: true, candidate: selfImprovementApi.readCandidate(id) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/approve') {
      const body = await bodyJson(req);
      sendJson(res, 202, selfImprovementApi.approve(body.id, body.token));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/deny') {
      const body = await bodyJson(req);
      sendJson(res, 200, selfImprovementApi.deny(body.id, body.token, body.reason));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/pause') {
      const body = await bodyJson(req);
      sendJson(res, 200, { ok: true, verified: true, status: selfImprovementApi.pause(body.token) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/resume') {
      const body = await bodyJson(req);
      sendJson(res, 200, { ok: true, verified: true, status: selfImprovementApi.resume(body.token) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/run-now') {
      const body = await bodyJson(req);
      sendJson(
        res,
        202,
        await selfImprovementApi.runNow(
          body.token,
          body.objective,
          body.kind
        )
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/self-improvement/abort') {
        const body = await bodyJson(req);
        const result = await selfImprovementApi.abort(
          body.token,
          body.reason || 'maker_abort',
          body.kind
        );
        let restoration = null;
        if (String(body.kind || result.run_kind || '') === 'training') {
          try {
            restoration = await exitTrainingRuntimeResourceMode({
              config: selfImprovementConfig,
              reason: 'nightly_training_aborted',
              liveAudio,
              visionReconciler,
              knowledgeBootstrap,
              applyLifecycle,
              buildLifecycle: readLifecycleStatus,
              restartKnowledge: async () => {
                if (typeof knowledgeBootstrap.start === 'function') {
                  return knowledgeBootstrap.start();
                }
                return null;
              },
              restart_scheduler: false
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              verified: false,
              marker: 'FLOKI_V2_TRAINING_ABORT_RESTORE_FAILED',
              error: error.message,
              abort: result
            });
            return;
          }
        }
        const verified = result && result.verified === true &&
          (!restoration || restoration.ok === true);
        sendJson(res, verified ? 200 : 500, {
          ...result,
          ok: verified,
          verified,
          restoration
        });
        return;
      }
    if (req.method === 'GET' && url.pathname === '/self-improvement/activity') {
      try {
        const rsiConfig = loadSelfImprovementConfig();
        const auditFile = path.join(
          rsiConfig.runtime_root,
          rsiConfig.audit_file_name
        );
        const rsiStatus = selfImprovementApi.status();
        const currentRunId = rsiStatus?.current_run_id || null;
        const lastSandboxLogFile = rsiStatus?.last_sandbox_log_file || null;
        const sandboxLogFile = currentRunId
          ? lastSandboxLogFile
          : lastSandboxLogFile;
        const displayRunId =
          currentRunId ||
          rsiRunIdFromLogFile(lastSandboxLogFile, rsiConfig);
        const parseActivityQueryInteger = (name, fallback) => {
          const raw = url.searchParams.get(name);
          if (raw == null || raw === '') return fallback;
          if (!/^\d+$/.test(raw)) {
            throw new Error('invalid self-improvement activity query integer: ' + name);
          }
          const value = Number(raw);
          if (!Number.isSafeInteger(value)) {
            throw new Error('self-improvement activity query integer is out of range: ' + name);
          }
          return value;
        };
        const auditCursor = parseActivityQueryInteger('audit_cursor', 0);
        const sandboxCursor = parseActivityQueryInteger('sandbox_cursor', 0);
        const initialActivityRequest = auditCursor === 0 && sandboxCursor === 0;
        const configuredDefault = initialActivityRequest
          ? rsiConfig.activity_stream_initial_events
          : rsiConfig.activity_stream_default_events;
        const parsedLimit = parseActivityQueryInteger('limit', configuredDefault);
        const maxEvents = Math.min(
          rsiConfig.activity_stream_max_events,
          Math.max(rsiConfig.activity_stream_min_events, parsedLimit)
        );
        const uiLimits = rsiStatus && rsiStatus.ui_limits;
        if (!uiLimits) {
          throw new Error('self-improvement UI limits are missing from chat YAML transport');
        }
        const maxBytes = rsiConfig.activity_stream_max_bytes;

        if (url.searchParams.get('init') === 'true') {
          const [auditSize, sandboxSize] = await Promise.all([
            jsonlFileSize(auditFile),
            sandboxLogFile
              ? jsonlFileSize(sandboxLogFile)
              : Promise.resolve(0)
          ]);
          sendJson(res, 200, {
            ok: true,
            events: [],
            cursor_mode: 'byte_offset',
            next_audit_cursor: auditSize,
            next_sandbox_cursor: sandboxSize,
            sandbox_log_file: sandboxLogFile,
            run_id: displayRunId,
            phase: rsiStatus?.phase || null,
            ui_limits: uiLimits
          });
          return;
        }


        const [auditChunk, sandboxChunk] = await Promise.all([
          readJsonlActivityChunk(auditFile, auditCursor, {
            source: 'controller',
            max_bytes: maxBytes,
            max_events: maxEvents
          }),
          sandboxLogFile
            ? readJsonlActivityChunk(
                sandboxLogFile,
                sandboxCursor,
                {
                  source: 'sandbox',
                  plain_text_fallback: true,
                  max_bytes: maxBytes,
                  max_events: maxEvents
                }
              )
            : Promise.resolve({
                events: [],
                next_cursor: 0,
                file_size: 0,
                cursor_reset: false
              })
        ]);

        const runScopedSandboxEvents = filterActivityEventsForRun(
          sandboxChunk.events,
          displayRunId || currentRunId
        );
        const merged = [
          ...auditChunk.events,
          ...runScopedSandboxEvents
        ].sort((a, b) => {
          const ta = String(a.record?.created_at || '');
          const tb = String(b.record?.created_at || '');
          if (ta !== tb) return ta < tb ? -1 : 1;
          return Number(a.index || 0) - Number(b.index || 0);
        });

        sendJson(res, 200, {
          ok: true,
          events: merged,
          cursor_mode: 'byte_offset',
          next_audit_cursor: auditChunk.next_cursor,
          next_sandbox_cursor: sandboxChunk.next_cursor,
          audit_cursor_reset: auditChunk.cursor_reset,
          sandbox_cursor_reset: sandboxChunk.cursor_reset,
          sandbox_log_file: sandboxLogFile,
          run_id: displayRunId,
          phase: rsiStatus?.phase || null,
          ui_limits: uiLimits
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message
        });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/self-improvement/terminal') {
        const config = loadSelfImprovementConfig();
        const { readNightlySession } = require('../self-improvement/training/nightly-training-session.cjs');
        const payload = await readRawTerminal({
          config,
          status: selfImprovementApi.status(),
          session: readNightlySession(config),
          cursor: Number(url.searchParams.get('cursor') || 0),
          before_cursor: url.searchParams.has('before_cursor')
            ? Number(url.searchParams.get('before_cursor'))
            : undefined,
          max_bytes: Number(url.searchParams.get('max_bytes') || 65536),
          requested_source_id: url.searchParams.get('source_id') || null
        });
        sendJson(res, 200, payload);
        return;
      }
    if (req.method === 'GET' && url.pathname === '/interface/vision/frame/latest.jpg') {
      try {
        const visionPaths = visionRuntimePaths({ runtime_dir: runtimeDir });
        const frame = await statExistingFileWithin(
          visionPaths.runtime_dir,
          visionPaths.latest_frame_file
        );
        if (!frame) {
          sendJson(res, 404, {
            ok: false,
            error: 'no frame available',
            reason: 'missing_frame'
          });
          return;
        }
        const maxFrameBytes = Math.max(
          4096,
          Number(getVisionConfig('chat').latest_frame_max_bytes || 8 * 1024 * 1024)
        );
        if (frame.stat.size > maxFrameBytes) {
          sendJson(res, 413, {
            ok: false,
            error: 'latest frame exceeds configured frame transport bound',
            reason: 'frame_too_large',
            frame_bytes: frame.stat.size,
            max_frame_bytes: maxFrameBytes
          });
          return;
        }
        const mtimeMs = Number(frame.stat.mtimeMs || 0);
        const ageMs = Math.max(0, Date.now() - mtimeMs);
        const liveChat = getLiveChatConfig('chat');
        const runtimeHeartbeatStaleMs = Math.max(
          3000,
          3 * Number(liveChat.runtime_heartbeat_ms || 1000)
        );
        const staleMs = Math.max(
          runtimeHeartbeatStaleMs,
          Number(getVisionConfig('chat').latest_frame_stale_ms || 0)
        );
        if (!Number.isFinite(mtimeMs) || mtimeMs <= 0 || ageMs > staleMs) {
          sendJson(res, 409, {
            ok: false,
            error: 'latest frame is stale',
            reason: 'stale_frame',
            frame_timestamp: frame.stat.mtime.toISOString(),
            frame_age_ms: ageMs,
            stale_after_ms: staleMs
          });
          return;
        }
        const snapshot = await readStableFrameSnapshot(frame.filePath, maxFrameBytes);
        if (!snapshot) {
          res.setHeader('Retry-After', '1');
          sendJson(res, 503, {
            ok: false,
            error: 'latest frame is being replaced; no stable snapshot obtained',
            reason: 'frame_snapshot_unstable',
            retryable: true
          });
          return;
        }
        const snapshotMtimeMs = Number(snapshot.stat.mtimeMs || mtimeMs);
        const snapshotAgeMs = Math.max(0, Date.now() - snapshotMtimeMs);
        await pipeFileResponse(res, snapshot.buffer, {
          'Content-Type': 'image/jpeg',
          'Content-Length': snapshot.buffer.length,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Floki-Frame-Timestamp': new Date(snapshotMtimeMs).toISOString(),
          'X-Floki-Frame-Age-Ms': String(snapshotAgeMs)
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/speak') {
      const body = await bodyJson(req);
      const text = String(body.text || '').trim();
      if (!text) throw new Error('speech text is required');
      const result = await liveAudio.speak(text, { source: 'runtime_api' });
      sendJson(res, 200, { ok: true, result });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  async function start() {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid) + '\n');
    state.state = 'starting';
    publish();

    const knowledgeConfig = getKnowledgeConfig('chat');
    const existingKnowledge = knowledgeBootstrap.inspect({ runtime_dir: runtimeDir });
    state.knowledge_ready = existingKnowledge.ready === true || knowledgeConfig.autoload_enabled !== true;
    state.knowledge_refresh_error = existingKnowledge.error || null;
    state.knowledge_autoload = Object.freeze({
      ...existingKnowledge,
      phase: 'pending_refresh',
      marker: existingKnowledge.marker
    });
    appendLog('knowledge bootstrap index: ' + String(existingKnowledge.marker) + ' sources=' + String(existingKnowledge.source_count || 0) + ' chunks=' + String(existingKnowledge.chunk_count || 0));

    const archive = reconcileArchive();
    appendLog('dream archive reconciled: discovered=' + String(archive.discovered) +
      ' indexed=' + String(archive.indexed) +
      ' already_indexed=' + String(archive.already_indexed) +
      ' malformed=' + String(archive.malformed));

    lifecycle = readLifecycleStatus();
    try {
      await liveAudio.start();
      state.hearing_start_error = null;
    } catch (error) {
      state.hearing_start_error = error.message;
      appendLog('hearing startup degraded: ' + error.message);
    }
    await applyLifecycle(lifecycle);

    server = http.createServer((req, res) => {
      route(req, res).catch((error) => {
        appendLog('request error: ' + error.stack);
        const httpStatus = /approval authorization failed/.test(String(error.message)) ? 403 : 500;
        sendJson(res, httpStatus, { ok: false, error: error.message });
      });
    });
    server.on('upgrade', (request, socket) => {
      try {
        const url = new URL(request.url, 'http://' + host + ':' + String(port));
        if (url.pathname !== '/ws') { socket.destroy(); return; }
        if (
          state.live_event_stream_enabled !== true ||
          state.websocket_ready !== true
        ) {
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n'
          );
          return;
        }
        const key = request.headers['sec-websocket-key'];
        if (typeof key !== 'string' || !key) throw new Error('missing WebSocket key');
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        websocketClients.add(socket); state.websocket_clients = websocketClients.size;
        socket.on('close', () => { websocketClients.delete(socket); state.websocket_clients = websocketClients.size; });
        socket.on('error', (error) => { websocketClients.delete(socket); state.websocket_clients = websocketClients.size; appendLog('websocket client error: ' + error.message); });
        socket.write(encodeWebSocketText({ type: 'status.update', data: status() }));
      } catch (error) { appendLog('websocket upgrade failed: ' + error.message); socket.destroy(); }
    });
    server.on('error', (error) => {
      state.last_error = error.message;
      publish();
    });
    await assertPortAvailable(host, port);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    state.api_ready = true;
    state.websocket_ready =
      state.live_event_stream_enabled === true;

    if (knowledgeConfig.autoload_enabled === true) {
      try {
        const launch = knowledgeBootstrap.start({
          runtime_dir: runtimeDir,
          on_update(update) {
            state.knowledge_refreshing = update.phase === 'refreshing';
            state.knowledge_worker_running = update.phase === 'refreshing';
            state.knowledge_refresh_error = update.error || null;
            state.knowledge_ready = update.ready === true;
            const existing = update.existing || {};
            state.knowledge_autoload = Object.freeze({
              ...(update.result || {}),
              phase: update.phase,
              marker: update.marker,
              source_count: Number(existing.source_count || (update.result && update.result.source_count) || 0),
              chunk_count: Number(existing.chunk_count || (update.result && update.result.chunk_count) || 0),
              knowledge_root: existing.knowledge_root || (update.result && update.result.knowledge_root) || null,
              error: update.error || null
            });
            appendLog('knowledge autoload ' + String(update.phase) + ': ' + String(update.marker) + ' sources=' + String(state.knowledge_autoload.source_count || 0) + ' chunks=' + String(state.knowledge_autoload.chunk_count || 0) + (update.error ? ' error=' + String(update.error) : ''));
            publish();
          }
        });
        state.knowledge_worker_started = launch.started === true;
        state.knowledge_worker_running = launch.started === true;
      } catch (error) {
        state.knowledge_refreshing = false;
        state.knowledge_worker_running = false;
        state.knowledge_refresh_error = error.message;
        appendLog('knowledge autoload worker launch failed: ' + error.message);
      }
    }

    const startupAudio = liveAudio.status();
    state.state = lifecycle.is_awake !== true
      ? 'sleeping'
      : (state.hearing_start_error || state.vision_start_error || startupAudio.last_error || startupAudio.last_wake_gate_error)
          ? 'degraded'
          : 'listening';
    publish();
    heartbeatTimer = setInterval(() => publish(), heartbeatMs);
    lifecycleTimer = setInterval(() => {
      void processManualNap().catch((error) => appendLog('manual nap processing failed: ' + error.message));
      const next = readLifecycleStatus();
      void applyLifecycle(next).catch((error) => {
        state.last_error = 'lifecycle reconciliation failed: ' + error.message;
        appendLog(state.last_error);
        publish();
      });
    }, lifecyclePollMs);
    appendLog('runtime ready on http://' + host + ':' + String(port));
    return status();
  }

  async function stop(options = {}) {
    if (stopping) return;
    stopping = true;
    state.client_ready = false;
    state.window_visible = false;
    state.senses_enabled = false;
    state.shutdown_requested = true;
    state.state = 'stopping';
    publish();
    if (activeAbortController) activeAbortController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    knowledgeBootstrap.stop();
    state.knowledge_worker_running = false;
    state.knowledge_refreshing = false;
    await liveAudio.stop();
    try {
      const visionStop = await visionShutdown({ stop_tunnel: true });
      if (visionStop && visionStop.ok === false) {
        appendLog('vision shutdown left survivors: ' + JSON.stringify(visionStop.stopped_pids || []));
      }
    } catch (error) {
      appendLog('vision shutdown failed: ' + error.message);
    }
    for (const socket of Array.from(websocketClients)) { try { socket.end(); } catch (error) { appendLog('websocket close failed: ' + error.message); } }
    websocketClients.clear();
    state.websocket_clients = 0;
    state.websocket_ready = false;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    if (!options.skipPidDeletion) fs.rmSync(pidFile, { force: true });
    state.api_ready = false;
    state.state = 'stopped';
    publish();
    appendLog('runtime stopped');
  }

  return Object.freeze({
    start,
    stop,
    status,
    publish,
    enqueueTurn,
    liveAudio,
    paths: Object.freeze({ runtime_dir: runtimeDir, pid_file: pidFile, status_file: statusFile, heartbeat_file: heartbeatFile, log_file: logFile })
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node 24 required, got ' + process.version);
  }
  const runtime = createChatLocalRuntime();
  const stop = async () => {
    try { await runtime.stop(); } finally { process.exit(0); }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const result = await runtime.start();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_LOCAL_RUNTIME_FAIL', error: error.stack || error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  jsonlFileSize,
  readJsonlActivityChunk,
  filterActivityEventsForRun,
  memoryPathsWritable,
  normalizeIntentText,
  configuredVisionQuestionPhrases,
  looksLikeVisionQuestion,
  configuredVisionHardwareQuestionPhrases,
  looksLikeVisionHardwareQuestion,
  configuredProhibitedPublicVisionTerms,
  toFirstPersonInnerExperience,
  visionObservationTimestamp,
  waitForFreshVision,
  pipeFileResponse,
  readStableFrameSnapshot,
  createChatLocalRuntime
};
