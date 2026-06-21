'use strict';

const path = require('node:path');
const {
  spawn } = require('node:child_process');

const {
  PROJECT_ROOT,
  getVisionConfig,
  getDetectionConfig: getYamlDetectionConfig
} = require('../config/floki-config.cjs');
const { existsSync } = require('../util/fs-safe.cjs');

let worker = null;
let ready = false;
let device = 'unknown';
let buffer = '';
let pending = null;
let pingTimer = null;
let explicitlyStopped = false;

function getGroundingDinoConfig() {
  const detection = getYamlDetectionConfig('chat');
  const promptMap = detection.grounding_dino_prompts;
  const promptConfigurationValid = Boolean(
    promptMap &&
    typeof promptMap === 'object' &&
    !Array.isArray(promptMap)
  );
  const prompts = promptConfigurationValid
    ? Object.keys(promptMap)
        .sort()
        .map((key) => String(promptMap[key] || '').trim())
        .filter(Boolean)
    : [];

  return Object.freeze({
    enabled: detection.grounding_dino_enabled === true,
    required: detection.hybrid_require_all_components !== false,
    modelPath: path.resolve(
      PROJECT_ROOT,
      detection.grounding_dino_model_path ||
        '.floki-tools/models/grounding-dino/grounding-dino-tiny'
    ),
    workerPath: path.resolve(
      PROJECT_ROOT,
      '.floki-tools/grounding-dino/grounding-dino-worker.py'
    ),
    pythonPath: path.resolve(
      PROJECT_ROOT,
      '.floki-tools/venv-chat-embodiment/bin/python3'
    ),
    boxThreshold: Number(detection.grounding_dino_box_threshold || 0.25),
    textThreshold: Number(detection.grounding_dino_text_threshold || 0.25),
    timeoutMs: Math.max(5000, Number(detection.grounding_dino_timeout_ms || 60000)),
    requireCuda: detection.grounding_dino_require_cuda !== false,
    promptConfigurationValid,
    prompts
  });
}

function clearPending(result) {
  if (!pending) return;
  clearTimeout(pending.timeout);
  const resolve = pending.resolve;
  pending = null;
  resolve(result);
}

function processLines() {
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      clearPending({
        ok: false,
        marker: 'GROUNDING_DINO_PROTOCOL_ERROR',
        error: error.message
      });
      continue;
    }

    if (message.type === 'ready' || message.type === 'pong') {
      ready = true;
      device = String(message.device || 'unknown');
      if (pingTimer) {
        clearTimeout(pingTimer);
        pingTimer = null;
      }
      continue;
    }

    if (message.type === 'result') {
      if (pending && message.frame_id === pending.frameId) {
        clearPending(message);
      }
      continue;
    }

    if (message.type === 'error') {
      if (pending && (!message.frame_id || message.frame_id === pending.frameId)) {
        clearPending({
          ok: false,
          marker: 'GROUNDING_DINO_INFERENCE_FAIL',
          error: String(message.message || 'Grounding DINO worker error')
        });
      }
    }
  }
}

function pingUntilReady() {
  if (ready || !worker || explicitlyStopped) return;
  try {
    worker.stdin.write(JSON.stringify({ type: 'ping' }) + '\n');
  } catch (_error) {
    // The exit/error handlers own failure reporting.
  }
  pingTimer = setTimeout(pingUntilReady, 500);
  if (typeof pingTimer.unref === 'function') pingTimer.unref();
}

function startGroundingDinoWorker() {
  if (worker && ready) {
    return Object.freeze({
      ok: true,
      marker: 'GROUNDING_DINO_WORKER_ALREADY_READY',
      device
    });
  }

  const config = getGroundingDinoConfig();
  if (!config.enabled) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_DISABLED',
      error: 'Grounding DINO is disabled in YAML'
    });
  }
  if (!existsSync(config.pythonPath)) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_PYTHON_MISSING',
      error: config.pythonPath
    });
  }
  if (!existsSync(config.workerPath)) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_WORKER_MISSING',
      error: config.workerPath
    });
  }
  if (!existsSync(config.modelPath)) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_MODEL_MISSING',
      error: config.modelPath
    });
  }
  if (!config.promptConfigurationValid) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_PROMPT_MAP_INVALID',
      error: 'grounding_dino_prompts must be a non-empty YAML map'
    });
  }
  if (config.prompts.length === 0) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_PROMPTS_MISSING',
      error: 'grounding_dino_prompts is empty'
    });
  }

  explicitlyStopped = false;
  ready = false;
  buffer = '';

  worker = spawn(config.pythonPath, [config.workerPath], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FLOKI_GROUNDING_DINO_MODEL: config.modelPath,
      FLOKI_GROUNDING_DINO_REQUIRE_CUDA: config.requireCuda ? '1' : '0',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_OFFLINE: '1',
      PYTHONUNBUFFERED: '1'
    }
  });

  const ownedWorker = worker;
  ownedWorker.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    processLines();
  });
  ownedWorker.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error('[GROUNDING-DINO] ' + text);
  });
  ownedWorker.on('error', (error) => {
    ready = false;
    clearPending({
      ok: false,
      marker: 'GROUNDING_DINO_WORKER_ERROR',
      error: error.message
    });
  });
  ownedWorker.on('exit', (code, signal) => {
    ready = false;
    if (worker === ownedWorker) worker = null;
    clearPending({
      ok: false,
      marker: 'GROUNDING_DINO_WORKER_EXITED',
      error: `worker exited code=${String(code)} signal=${String(signal || 'none')}`
    });
  });

  pingUntilReady();
  return Object.freeze({
    ok: true,
    marker: 'GROUNDING_DINO_WORKER_SPAWNED',
    pid: ownedWorker.pid
  });
}

async function waitForGroundingDinoReady(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ready && worker) {
      return Object.freeze({
        ok: true,
        marker: 'GROUNDING_DINO_WORKER_READY',
        device
      });
    }
    if (!worker) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Object.freeze({
    ok: false,
    marker: 'GROUNDING_DINO_START_TIMEOUT',
    error: 'Grounding DINO did not become ready'
  });
}

async function runGroundingDinoOnFrame(framePath) {
  const config = getGroundingDinoConfig();
  if (pending) {
    return Object.freeze({
      ok: false,
      marker: 'GROUNDING_DINO_BUSY',
      error: 'A Grounding DINO request is already active'
    });
  }

  const started = startGroundingDinoWorker();
  if (!started.ok) return started;
  const workerReady = ready
    ? { ok: true }
    : await waitForGroundingDinoReady(config.timeoutMs);
  if (!workerReady.ok) return workerReady;

  const frameId = `dino_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pending && pending.frameId === frameId) {
        pending = null;
        resolve({
          ok: false,
          marker: 'GROUNDING_DINO_TIMEOUT',
          error: `Grounding DINO exceeded ${config.timeoutMs}ms`
        });
      }
    }, config.timeoutMs);

    pending = { frameId, resolve, timeout };
    try {
      worker.stdin.write(JSON.stringify({
        type: 'detect',
        frame_path: framePath,
        frame_id: frameId,
        prompts: config.prompts,
        box_threshold: config.boxThreshold,
        text_threshold: config.textThreshold
      }) + '\n');
    } catch (error) {
      clearPending({
        ok: false,
        marker: 'GROUNDING_DINO_STDIN_FAIL',
        error: error.message
      });
    }
  });
}

function stopGroundingDinoWorker() {
  explicitlyStopped = true;
  ready = false;
  if (pingTimer) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
  clearPending({
    ok: false,
    marker: 'GROUNDING_DINO_STOPPED',
    error: 'Grounding DINO worker stopped'
  });
  const ownedWorker = worker;
  worker = null;
  if (!ownedWorker) {
    return Object.freeze({ ok: true, marker: 'GROUNDING_DINO_ALREADY_STOPPED' });
  }
  try {
    ownedWorker.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
  } catch (_error) {
    // Continue to SIGTERM.
  }
  try {
    ownedWorker.kill('SIGTERM');
  } catch (_error) {
    // Process may already have exited.
  }
  const killTimer = setTimeout(() => {
    try {
      if (ownedWorker.exitCode === null && ownedWorker.signalCode === null) {
        ownedWorker.kill('SIGKILL');
      }
    } catch (_error) {
      // Process may already have exited.
    }
  }, 2000);
  if (typeof killTimer.unref === 'function') killTimer.unref();
  return Object.freeze({
    ok: true,
    marker: 'GROUNDING_DINO_STOP_REQUESTED',
    pid: ownedWorker.pid
  });
}

module.exports = {
  getGroundingDinoConfig,
  startGroundingDinoWorker,
  runGroundingDinoOnFrame,
  stopGroundingDinoWorker
};
