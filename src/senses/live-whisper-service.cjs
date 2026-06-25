'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  PROJECT_ROOT: ROOT,
  getAudioConfig,
  getTimeoutConfig
} = require('../config/floki-config.cjs');
const { nowIso } = require('../util/time.cjs');

const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const WHISPER_BIN_DIR = path.join(
  TOOLS_DIR,
  'repos',
  'whisper.cpp',
  'build',
  'bin'
);
const WHISPER_CLI = path.join(WHISPER_BIN_DIR, 'whisper-cli');
const WHISPER_SERVER = path.join(WHISPER_BIN_DIR, 'whisper-server');
const WHISPER_MODEL_DIR = path.join(
  TOOLS_DIR,
  'repos',
  'whisper.cpp',
  'models'
);

let sharedStartPromise = null;
let sharedDescriptor = null;
let sharedReferences = 0;

function executable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function fileReady(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function whisperModelPath(size) {
  const normalized = String(size).trim().toLowerCase();
  const names = {
    tiny: 'ggml-tiny.en.bin',
    small: 'ggml-small.en.bin',
    med: 'ggml-medium.en.bin',
    medium: 'ggml-medium.en.bin',
    large: 'ggml-large-v3.bin'
  };
  if (!names[normalized]) {
    throw new Error('unsupported Whisper model size: ' + normalized);
  }
  return path.join(WHISPER_MODEL_DIR, names[normalized]);
}

function parseWhisperText(rawText) {
  const raw = String(rawText || '').replace(/\r/g, ' ').trim();
  const ambientLabels = [];
  for (const match of raw.matchAll(/\[([^\]]{2,80})\]|\(([^)]{2,80})\)/g)) {
    const label = String(match[1] || match[2] || '').trim();
    if (
      label &&
      /music|bark|dog|baby|cry|laugh|door|knock|footstep|alarm|noise|applause|cough|sneeze|silence|clap|ring|bell/i.test(label)
    ) {
      ambientLabels.push(label);
    }
  }
  const speechText = raw
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Object.freeze({
    raw_text: raw,
    speech_text: /[A-Za-z0-9]{2,}/.test(speechText) ? speechText : '',
    ambient_labels: [...new Set(ambientLabels)]
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHttp(host, port, audio, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get({
        host,
        port,
        path: audio.whisper_server_probe_path,
        timeout: audio.whisper_server_probe_request_timeout_ms
      }, (response) => {
        response.resume();
        resolve(true);
      });
      request.once('error', () => {
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(
          attempt,
          audio.whisper_server_probe_poll_ms
        );
      });
      request.once('timeout', () => request.destroy());
    };
    attempt();
  });
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function processCommand(pid, processRoot) {
  try {
    return fs
      .readFileSync(path.join(processRoot, String(pid), 'cmdline'))
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function discoverWhisperServerProcessIds(audio) {
  let entries = [];
  try {
    entries = fs.readdirSync(
      audio.whisper_process_root,
      { withFileTypes: true }
    );
  } catch (_error) {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const command = processCommand(pid, audio.whisper_process_root);
    if (command[0] === WHISPER_SERVER) matches.push(pid);
  }
  return matches.sort((left, right) => left - right);
}

function configuredLockPath(audio) {
  const configured = path.resolve(
    ROOT,
    String(audio.whisper_singleton_lock_file)
  );
  if (
    configured !== ROOT &&
    !configured.startsWith(ROOT + path.sep)
  ) {
    throw new Error(
      'audio.whisper_singleton_lock_file escapes project root'
    );
  }
  return configured;
}

function readLock(lockFile) {
  try {
    const value = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return {
      owner_pid: Number(value.owner_pid),
      server_pid: Number(value.server_pid || 0),
      created_at: value.created_at || null
    };
  } catch (_error) {
    return null;
  }
}

function writeLock(lockFile, value, exclusive) {
  fs.mkdirSync(path.dirname(lockFile), {
    recursive: true,
    mode: 0o700
  });
  const flags = exclusive ? 'wx' : 'w';
  const descriptor = fs.openSync(lockFile, flags, 0o600);
  try {
    fs.writeFileSync(
      descriptor,
      JSON.stringify(value, null, 2) + '\n'
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function lockOwnedByCurrentProcess(lockFile) {
  const lock = readLock(lockFile);
  return Boolean(lock && lock.owner_pid === process.pid);
}

function releaseOwnedLock(lockFile) {
  if (!lockOwnedByCurrentProcess(lockFile)) return false;
  fs.rmSync(lockFile, { force: true });
  return true;
}

async function waitForProcessesExit(pids, audio) {
  const deadline =
    Date.now() + audio.whisper_process_stop_timeout_ms;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    await sleep(audio.whisper_process_stop_poll_ms);
  }
  return pids.every((pid) => !processAlive(pid));
}

async function terminateWhisperProcesses(pids, audio) {
  const unique = [...new Set(pids.map(Number).filter(processAlive))];
  if (unique.length === 0) return [];

  for (const pid of unique) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_error) {
      // Process exited after discovery.
    }
  }

  if (!(await waitForProcessesExit(unique, audio))) {
    for (const pid of unique) {
      if (!processAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_error) {
        // Process exited before the force-stop request.
      }
    }
    await waitForProcessesExit(unique, audio);
  }

  const survivors = unique.filter(processAlive);
  if (survivors.length > 0) {
    throw new Error(
      'could not stop duplicate whisper-server processes: ' +
      survivors.join(',')
    );
  }
  return unique;
}

async function acquireWhisperOwnership(audio, host, port) {
  const lockFile = configuredLockPath(audio);
  const deadline =
    Date.now() + audio.whisper_server_start_timeout_ms;

  while (Date.now() < deadline) {
    const processIds = discoverWhisperServerProcessIds(audio);
    const serverReady = await waitForHttp(
      host,
      port,
      audio,
      audio.whisper_server_probe_timeout_ms
    );
    const currentLock = readLock(lockFile);

    if (
      serverReady &&
      processIds.length === 1 &&
      currentLock &&
      processAlive(currentLock.owner_pid)
    ) {
      return {
        lock_file: lockFile,
        owned: currentLock.owner_pid === process.pid,
        owner_pid: currentLock.owner_pid,
        pid: processIds[0],
        process: null
      };
    }

    if (
      currentLock &&
      currentLock.owner_pid === process.pid
    ) {
      return {
        lock_file: lockFile,
        owned: true,
        owner_pid: process.pid,
        pid: Number(currentLock.server_pid || 0),
        process: null
      };
    }

    if (
      currentLock &&
      processAlive(currentLock.owner_pid)
    ) {
      await sleep(audio.whisper_process_stop_poll_ms);
      continue;
    }

    if (currentLock) fs.rmSync(lockFile, { force: true });

    try {
      writeLock(lockFile, {
        owner_pid: process.pid,
        server_pid: 0,
        created_at: nowIso()
      }, true);
      return {
        lock_file: lockFile,
        owned: true,
        owner_pid: process.pid,
        pid: 0,
        process: null
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(audio.whisper_process_stop_poll_ms);
    }
  }

  throw new Error(
    'timed out acquiring Whisper singleton ownership'
  );
}

async function startSharedServer(audio, modelFile, host, port) {
  if (
    sharedDescriptor &&
    await waitForHttp(
      host,
      port,
      audio,
      audio.whisper_server_probe_timeout_ms
    )
  ) {
    return sharedDescriptor;
  }

  if (sharedStartPromise) return sharedStartPromise;

  sharedStartPromise = (async () => {
    const ownership = await acquireWhisperOwnership(
      audio,
      host,
      port
    );

    if (!ownership.owned) {
      sharedDescriptor = {
        ...ownership,
        ready: true
      };
      return sharedDescriptor;
    }

    const existing = discoverWhisperServerProcessIds(audio);
    const existingReady = await waitForHttp(
      host,
      port,
      audio,
      audio.whisper_server_probe_timeout_ms
    );

    if (existing.length === 1 && existingReady) {
      writeLock(ownership.lock_file, {
        owner_pid: process.pid,
        server_pid: existing[0],
        created_at: nowIso()
      }, false);
      sharedDescriptor = {
        ...ownership,
        pid: existing[0],
        ready: true
      };
      return sharedDescriptor;
    }

    if (existing.length > 0) {
      await terminateWhisperProcesses(existing, audio);
    }

    if (
      await waitForHttp(
        host,
        port,
        audio,
        audio.whisper_server_probe_timeout_ms
      )
    ) {
      releaseOwnedLock(ownership.lock_file);
      throw new Error(
        'Whisper port is occupied by an unknown process: ' +
        host + ':' + String(port)
      );
    }

    const child = spawn(WHISPER_SERVER, [
      '-m', modelFile,
      '--host', host,
      '--port', String(port),
      '-l', String(audio.whisper_language)
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    let spawnError = null;
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.once('error', (error) => {
      spawnError = error;
    });

    const ready = await waitForHttp(
      host,
      port,
      audio,
      audio.whisper_server_start_timeout_ms
    );
    if (!ready) {
      try {
        child.kill('SIGTERM');
      } catch (_error) {
        // Child may already have exited.
      }
      await waitForProcessesExit(
        child.pid ? [child.pid] : [],
        audio
      );
      releaseOwnedLock(ownership.lock_file);
      throw new Error(
        'whisper-server did not become ready: ' +
        (
          spawnError
            ? spawnError.message
            : stderr.slice(-audio.whisper_error_tail_chars)
        )
      );
    }

    const active = discoverWhisperServerProcessIds(audio);
    if (active.length !== 1 || active[0] !== child.pid) {
      await terminateWhisperProcesses(active, audio);
      releaseOwnedLock(ownership.lock_file);
      throw new Error(
        'Whisper singleton verification expected one process, found ' +
        String(active.length)
      );
    }

    writeLock(ownership.lock_file, {
      owner_pid: process.pid,
      server_pid: child.pid,
      created_at: nowIso()
    }, false);

    child.once('close', () => {
      if (
        sharedDescriptor &&
        sharedDescriptor.pid === child.pid
      ) {
        sharedDescriptor.ready = false;
      }
    });

    sharedDescriptor = {
      ...ownership,
      pid: child.pid,
      process: child,
      ready: true
    };
    return sharedDescriptor;
  })();

  try {
    return await sharedStartPromise;
  } finally {
    sharedStartPromise = null;
  }
}

async function stopSharedServer(audio) {
  if (!sharedDescriptor) return;

  const descriptor = sharedDescriptor;
  sharedDescriptor = null;

  if (!descriptor.owned) return;

  const processIds = discoverWhisperServerProcessIds(audio);
  await terminateWhisperProcesses(processIds, audio);
  releaseOwnedLock(descriptor.lock_file);
}

function createLiveWhisperService(options = {}) {
  const audio = options.audio_config || getAudioConfig('chat');
  const modelFile = whisperModelPath(audio.whisper_model_size);
  const serverHost = String(audio.whisper_server_host);
  const serverPort = Number(audio.whisper_server_port);
  const preferServer = audio.whisper_server_enabled === true;
  const state = {
    ready: false,
    backend: 'unavailable',
    model_ready: fileReady(modelFile),
    cli_ready: executable(WHISPER_CLI),
    server_binary_ready: executable(WHISPER_SERVER),
    server_process_ready: false,
    server_pid: null,
    server_owned: false,
    last_error: null,
    last_transcription_started_at: null,
    last_transcription_completed_at: null,
    transcriptions_completed: 0
  };
  let attached = false;
  let stopping = false;

  function syncSharedState() {
    state.server_process_ready = Boolean(
      sharedDescriptor && sharedDescriptor.ready
    );
    state.server_pid =
      sharedDescriptor && sharedDescriptor.pid || null;
    state.server_owned = Boolean(
      sharedDescriptor && sharedDescriptor.owned
    );
  }

  function status() {
    syncSharedState();
    return Object.freeze({
      marker: 'FLOKI_V2_LIVE_WHISPER_STATUS',
      ...state,
      model_file: modelFile,
      server_host: serverHost,
      server_port: serverPort,
      server_process_count:
        discoverWhisperServerProcessIds(audio).length
    });
  }

  async function startServer() {
    if (
      !preferServer ||
      !state.server_binary_ready ||
      !state.model_ready
    ) {
      return false;
    }

    const descriptor = await startSharedServer(
      audio,
      modelFile,
      serverHost,
      serverPort
    );

    if (!attached) {
      attached = true;
      sharedReferences += 1;
    }

    state.server_process_ready = descriptor.ready === true;
    state.server_pid = descriptor.pid || null;
    state.server_owned = descriptor.owned === true;
    state.backend = 'server';
    state.ready = true;
    state.last_error = null;
    return true;
  }

  async function start() {
    stopping = false;
    state.model_ready = fileReady(modelFile);
    state.cli_ready = executable(WHISPER_CLI);
    state.server_binary_ready = executable(WHISPER_SERVER);

    if (!state.model_ready) {
      throw new Error('Whisper model missing: ' + modelFile);
    }
    if (state.ready) return status();

    const serverStarted = await startServer();
    if (!serverStarted) {
      if (!state.cli_ready) {
        throw new Error(
          'Neither whisper-server nor whisper-cli is available'
        );
      }
      state.backend = 'cli_fallback';
      state.ready = true;
    }
    return status();
  }

  function transcribeCli(inputFile) {
    const outputBase =
      inputFile.replace(/\.wav$/i, '') + '.whisper';
    const outputTxt = outputBase + '.txt';
    fs.rmSync(outputTxt, { force: true });

    return new Promise((resolve, reject) => {
      const child = spawn(WHISPER_CLI, [
        '-m', modelFile,
        '-f', inputFile,
        '-l', String(audio.whisper_language),
        '-otxt',
        '-of', outputBase
      ], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(
        () => child.kill('SIGKILL'),
        getTimeoutConfig('chat').whisper_ms
      );

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '');
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        let text = '';
        try {
          text = fs.readFileSync(outputTxt, 'utf8');
        } catch (_error) {
          text = stdout;
        }
        fs.rmSync(outputTxt, { force: true });
        if (code !== 0) {
          reject(new Error(
            'whisper-cli failed (' +
            String(code) + '/' + String(signal || '') +
            '): ' +
            stderr.trim().slice(
              0,
              audio.whisper_error_tail_chars
            )
          ));
          return;
        }
        resolve(parseWhisperText(text || stdout));
      });
    });
  }

  async function transcribeServer(inputFile) {
    const bytes = fs.readFileSync(inputFile);
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: 'audio/wav' }),
      path.basename(inputFile)
    );
    form.append('response_format', 'json');
    form.append('language', String(audio.whisper_language));

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      getTimeoutConfig('chat').whisper_ms
    );
    try {
      const response = await fetch(
        'http://' + serverHost + ':' +
        String(serverPort) + '/inference',
        {
          method: 'POST',
          body: form,
          signal: controller.signal
        }
      );
      if (!response.ok) {
        throw new Error(
          'whisper-server HTTP ' +
          response.status + ': ' +
          (await response.text()).slice(
            0,
            audio.whisper_error_tail_chars
          )
        );
      }
      const type = String(
        response.headers.get('content-type') || ''
      );
      if (type.includes('application/json')) {
        const payload = await response.json();
        return parseWhisperText(
          payload.text ||
          payload.transcription ||
          payload.result ||
          ''
        );
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
          state.last_error =
            'whisper-server inference failed; ' +
            'falling back to CLI: ' + error.message;
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
    if (attached) {
      attached = false;
      sharedReferences = Math.max(0, sharedReferences - 1);
    }
    if (sharedReferences === 0) {
      await stopSharedServer(audio);
    }
    state.server_process_ready = false;
    state.server_pid = null;
    state.server_owned = false;
    state.ready = false;
    return status();
  }

  return Object.freeze({
    start,
    stop,
    transcribe,
    status
  });
}

module.exports = {
  ROOT,
  WHISPER_CLI,
  WHISPER_SERVER,
  WHISPER_MODEL_DIR,
  whisperModelPath,
  parseWhisperText,
  processAlive,
  discoverWhisperServerProcessIds,
  waitForProcessesExit,
  terminateWhisperProcesses,
  createLiveWhisperService
};
