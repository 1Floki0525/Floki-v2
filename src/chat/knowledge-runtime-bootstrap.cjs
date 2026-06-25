
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const {
  PROJECT_ROOT: ROOT,
  getPathConfig,
  getTimeoutConfig
} = require('../config/floki-config.cjs');
const { getKnowledgePaths } = require('./knowledge-ingestion.cjs');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return Object.freeze({ value: null, error: null });
  }
  try {
    return Object.freeze({
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      error: null
    });
  } catch (error) {
    return Object.freeze({ value: null, error: error.message });
  }
}

function readExistingKnowledgeState(options = {}) {
  const paths = getKnowledgePaths(options);
  const loaded = readJson(paths.index_json);
  const index = loaded.value;
  const sourceCount = Number(index && index.source_count_total || 0);
  const chunkCount = Number(index && index.chunk_count_total || 0);
  const chunksPresent = fs.existsSync(paths.chunks_jsonl) &&
    fs.statSync(paths.chunks_jsonl).size > 0;
  const ready = Boolean(
    !loaded.error &&
    index &&
    index.ok === true &&
    chunkCount > 0 &&
    chunksPresent
  );

  return Object.freeze({
    ok: true,
    ready,
    marker: ready
      ? 'FLOKI_V2_KNOWLEDGE_EXISTING_INDEX_READY'
      : loaded.error
        ? 'FLOKI_V2_KNOWLEDGE_EXISTING_INDEX_INVALID'
        : 'FLOKI_V2_KNOWLEDGE_EXISTING_INDEX_NOT_READY',
    knowledge_root: paths.root,
    source_count: sourceCount,
    chunk_count: chunkCount,
    updated_at: index && index.updated_at || null,
    error: loaded.error,
    chat_mode_only: true,
    game_mode_started: false
  });
}

function createKnowledgeRuntimeBootstrap(options = {}) {
  const workerPath = options.worker_path ||
    path.join(ROOT, 'src/chat/knowledge-autoload-worker.cjs');
  const forkWorker = options.fork_worker || ((env) => fork(workerPath, [], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  }));
  let activeRun = null;

  function start(startOptions = {}) {
    if (activeRun) {
      return Object.freeze({
        started: false,
        reason: 'already_running',
        worker: activeRun.worker
      });
    }

    const runtimeDir = path.resolve(
      startOptions.runtime_dir ||
      options.runtime_dir ||
      path.resolve(ROOT, getPathConfig('chat').chat_runtime_root)
    );
    const onUpdate = typeof startOptions.on_update === 'function'
      ? startOptions.on_update
      : () => {};
    const existing = readExistingKnowledgeState(startOptions);

    onUpdate(Object.freeze({
      phase: 'refreshing',
      ready: existing.ready,
      marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_REFRESHING',
      error: null,
      existing
    }));

    const worker = forkWorker({
      FLOKI_KNOWLEDGE_RUNTIME_DIR: runtimeDir
    });
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const run = {
      worker,
      settled: false,
      stop_requested: false,
      on_update: onUpdate,
      start_options: startOptions,
      exit_promise: exitPromise,
      resolve_exit: resolveExit
    };
    activeRun = run;

    const finish = (update) => {
      if (run.settled || run.stop_requested) return;
      run.settled = true;
      run.on_update(Object.freeze(update));
    };

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object' || run.stop_requested) return;
      if (message.type === 'knowledge-autoload-complete') {
        const refreshed = readExistingKnowledgeState(run.start_options);
        finish({
          phase: 'complete',
          ready: refreshed.ready,
          marker: message.result && message.result.marker ||
            'FLOKI_V2_KNOWLEDGE_AUTOLOAD_COMPLETE',
          error: null,
          result: message.result || null,
          existing: refreshed
        });
      } else if (message.type === 'knowledge-autoload-error') {
        const refreshed = readExistingKnowledgeState(run.start_options);
        finish({
          phase: 'failed',
          ready: refreshed.ready,
          marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_FAILED',
          error: String(message.error || 'knowledge autoload worker failed'),
          existing: refreshed
        });
      }
    });

    worker.once('error', (error) => {
      if (!run.stop_requested) {
        const refreshed = readExistingKnowledgeState(run.start_options);
        finish({
          phase: 'failed',
          ready: refreshed.ready,
          marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_WORKER_ERROR',
          error: error.message,
          existing: refreshed
        });
      }
    });

    worker.once('exit', (code, signal) => {
      if (!run.stop_requested && !run.settled) {
        const refreshed = readExistingKnowledgeState(run.start_options);
        finish({
          phase: code === 0 ? 'complete' : 'failed',
          ready: refreshed.ready,
          marker: code === 0
            ? 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_WORKER_EXITED'
            : 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_WORKER_EXIT_FAIL',
          error: code === 0
            ? null
            : 'knowledge autoload worker exited with code ' +
              String(code) +
              ' signal ' +
              String(signal || ''),
          existing: refreshed
        });
      }
      if (activeRun === run) activeRun = null;
      run.resolve_exit(Object.freeze({ code, signal }));
    });

    return Object.freeze({
      started: true,
      worker,
      existing,
      exit_promise: exitPromise
    });
  }

  function stop() {
    if (!activeRun) return false;
    const run = activeRun;
    activeRun = null;
    run.stop_requested = true;
    run.settled = true;
    if (run.worker.connected) run.worker.disconnect();
    if (!run.worker.killed) run.worker.kill('SIGTERM');
    return true;
  }

  async function stopAndWait() {
    if (!activeRun) return false;
    const run = activeRun;
    stop();
    const timeoutMs = Number(
      getTimeoutConfig('chat').knowledge_autoload_ms
    );
    await Promise.race([
      run.exit_promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            'knowledge autoload worker did not stop within ' +
            String(timeoutMs) +
            'ms'
          ));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
    return true;
  }

  return Object.freeze({
    start,
    stop,
    stopAndWait,
    inspect: (inspectOptions = {}) => readExistingKnowledgeState(inspectOptions),
    running: () => Boolean(activeRun)
  });
}

module.exports = {
  readExistingKnowledgeState,
  createKnowledgeRuntimeBootstrap
};
