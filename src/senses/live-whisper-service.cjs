'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { PROJECT_ROOT: ROOT, getAudioConfig, getTimeoutConfig } = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');

const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const WHISPER_BIN_DIR = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'build', 'bin');
const WHISPER_CLI = path.join(WHISPER_BIN_DIR, 'whisper-cli');
const WHISPER_SERVER = path.join(WHISPER_BIN_DIR, 'whisper-server');
const WHISPER_MODEL_DIR = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'models');

function executable(filePath) {
  try { fs.accessSync(filePath, fs.constants.X_OK); return true; } catch (_error) { return false; }
}

function fileReady(filePath) {
  try { const stat = fs.statSync(filePath); return stat.isFile() && stat.size > 0; } catch (_error) { return false; }
}

function whisperModelPath(size) {
  const normalized = String(size || 'small').trim().toLowerCase();
  const names = { tiny: 'ggml-tiny.en.bin', small: 'ggml-small.en.bin', med: 'ggml-medium.en.bin', medium: 'ggml-medium.en.bin', large: 'ggml-large-v3.bin' };
  if (!names[normalized]) throw new Error('unsupported Whisper model size: ' + normalized);
  return path.join(WHISPER_MODEL_DIR, names[normalized]);
}

function parseWhisperText(rawText) {
  const raw = String(rawText || '').replace(/\r/g, ' ').trim();
  const ambientLabels = [];
  for (const match of raw.matchAll(/\[([^\]]{2,80})\]|\(([^)]{2,80})\)/g)) {
    const label = String(match[1] || match[2] || '').trim();
    if (label && /music|bark|dog|baby|cry|laugh|door|knock|footstep|alarm|noise|applause|cough|sneeze|silence|clap|ring|bell/i.test(label)) ambientLabels.push(label);
  }
  const speechText = raw.replace(/\[[^\]]+\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return Object.freeze({
    raw_text: raw,
    speech_text: /[A-Za-z0-9]{2,}/.test(speechText) ? speechText : '',
    ambient_labels: [...new Set(ambientLabels)]
  });
}

function waitForHttp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host, port, path: '/', timeout: 500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

function createLiveWhisperService(options = {}) {
  const audio = options.audio_config || getAudioConfig('chat');
  const modelFile = whisperModelPath(audio.whisper_model_size);
  const serverHost = String(audio.whisper_server_host || '127.0.0.1');
  const serverPort = Number(audio.whisper_server_port || 7788);
  const preferServer = audio.whisper_server_enabled !== false;
  const state = {
    ready: false,
    backend: 'unavailable',
    model_ready: fileReady(modelFile),
    cli_ready: executable(WHISPER_CLI),
    server_binary_ready: executable(WHISPER_SERVER),
    server_process_ready: false,
    server_pid: null,
    last_error: null,
    last_transcription_started_at: null,
    last_transcription_completed_at: null,
    transcriptions_completed: 0
  };
  let serverProcess = null;
  let stopping = false;

  function status() {
    return Object.freeze({
      marker: 'FLOKI_V2_LIVE_WHISPER_STATUS',
      ...state,
      model_file: modelFile,
      server_host: serverHost,
      server_port: serverPort
    });
  }

  async function startServer() {
    if (!preferServer || !state.server_binary_ready || !state.model_ready) return false;
    serverProcess = spawn(WHISPER_SERVER, [
      '-m', modelFile,
      '--host', serverHost,
      '--port', String(serverPort),
      '-l', 'en'
    ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    state.server_pid = serverProcess.pid || null;
    let stderr = '';
    serverProcess.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    serverProcess.once('error', (error) => { state.last_error = 'whisper-server: ' + error.message; });
    serverProcess.once('close', (code, signal) => {
      state.server_process_ready = false;
      state.server_pid = null;
      if (!stopping && state.backend === 'server') {
        state.backend = state.cli_ready ? 'cli_fallback' : 'unavailable';
        state.ready = state.cli_ready && state.model_ready;
        state.last_error = 'whisper-server exited (' + String(code) + '/' + String(signal || '') + '): ' + stderr.trim().slice(-500);
      }
    });
    const ready = await waitForHttp(serverHost, serverPort, Number(audio.whisper_server_start_timeout_ms || 15000));
    if (!ready) {
      if (serverProcess && serverProcess.pid) serverProcess.kill('SIGTERM');
      state.server_pid = null;
      state.server_process_ready = false;
      state.last_error = 'whisper-server did not become ready; using CLI fallback';
      return false;
    }
    state.server_process_ready = true;
    state.backend = 'server';
    state.ready = true;
    state.last_error = null;
    return true;
  }

  async function start() {
    state.model_ready = fileReady(modelFile);
    state.cli_ready = executable(WHISPER_CLI);
    state.server_binary_ready = executable(WHISPER_SERVER);
    if (!state.model_ready) throw new Error('Whisper model missing: ' + modelFile);
    const serverStarted = await startServer();
    if (!serverStarted) {
      if (!state.cli_ready) throw new Error('Neither whisper-server nor whisper-cli is available');
      state.backend = 'cli_fallback';
      state.ready = true;
    }
    return status();
  }

  function transcribeCli(inputFile) {
    const outputBase = inputFile.replace(/\.wav$/i, '') + '.whisper';
    const outputTxt = outputBase + '.txt';
    fs.rmSync(outputTxt, { force: true });
    return new Promise((resolve, reject) => {
      const child = spawn(WHISPER_CLI, ['-m', modelFile, '-f', inputFile, '-l', 'en', '-otxt', '-of', outputBase], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), Number(getTimeoutConfig('chat').whisper_ms || 120000));
      child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        let text = '';
        try { text = fs.readFileSync(outputTxt, 'utf8'); } catch (_error) { text = stdout; }
        fs.rmSync(outputTxt, { force: true });
        if (code !== 0) {
          reject(new Error('whisper-cli failed (' + String(code) + '/' + String(signal || '') + '): ' + stderr.trim().slice(0, 800)));
          return;
        }
        resolve(parseWhisperText(text || stdout));
      });
    });
  }

  async function transcribeServer(inputFile) {
    const bytes = fs.readFileSync(inputFile);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(inputFile));
    form.append('response_format', 'json');
    form.append('language', 'en');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(getTimeoutConfig('chat').whisper_ms || 120000));
    try {
      const response = await fetch('http://' + serverHost + ':' + String(serverPort) + '/inference', { method: 'POST', body: form, signal: controller.signal });
      if (!response.ok) throw new Error('whisper-server HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
      const type = String(response.headers.get('content-type') || '');
      if (type.includes('application/json')) {
        const payload = await response.json();
        return parseWhisperText(payload.text || payload.transcription || payload.result || '');
      }
      return parseWhisperText(await response.text());
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcribe(inputFile) {
    if (!state.ready) throw new Error('Whisper is not ready');
    state.last_transcription_started_at = nowIso();
    try {
      let result;
      if (state.backend === 'server') {
        try {
          result = await transcribeServer(inputFile);
        } catch (error) {
          state.last_error = 'whisper-server inference failed; falling back to CLI: ' + error.message;
          state.backend = 'cli_fallback';
          state.server_process_ready = false;
          result = await transcribeCli(inputFile);
        }
      } else {
        result = await transcribeCli(inputFile);
      }
      state.last_transcription_completed_at = nowIso();
      state.transcriptions_completed += 1;
      return result;
    } catch (error) {
      state.last_error = error.message;
      throw error;
    }
  }

  async function stop() {
    stopping = true;
    if (serverProcess && serverProcess.pid) serverProcess.kill('SIGTERM');
    state.server_process_ready = false;
    state.server_pid = null;
    state.ready = false;
    return status();
  }

  return Object.freeze({ start, stop, transcribe, status });
}

module.exports = {
  ROOT,
  WHISPER_CLI,
  WHISPER_SERVER,
  WHISPER_MODEL_DIR,
  whisperModelPath,
  parseWhisperText,
  createLiveWhisperService
};
