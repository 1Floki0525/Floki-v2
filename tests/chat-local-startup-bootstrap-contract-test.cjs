'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createChatLocalRuntime } = require('../src/runtime/chat-local-runtime.cjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function fakeAudio() {
  let awake = false;
  let stopped = false;
  return {
    async start() { return this.status(); },
    async stop() { stopped = true; awake = false; return this.status(); },
    async setAwake(value) { awake = value === true; return this.status(); },
    status() {
      return {
        service_state: stopped ? 'stopped' : (awake ? 'listening' : 'sleeping'),
        awake,
        speaking: false,
        microphone_open: false,
        vad_ready: true,
        whisper_ready: true,
        piper_ready: true,
        playback_ready: true,
        last_error: null,
        last_wake_gate_error: null,
        last_heartbeat_at: new Date().toISOString()
      };
    },
    speak: async () => ({ ok: true }),
    interruptSpeech: async () => ({ ok: true })
  };
}

async function run() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-startup-bootstrap-'));
  const port = await freePort();
  let stoppedWorker = false;
  let completionTimer = null;

  const knowledgeBootstrap = {
    inspect() {
      return {
        ok: true,
        ready: false,
        marker: 'FLOKI_V2_KNOWLEDGE_EXISTING_INDEX_NOT_READY',
        knowledge_root: path.join(runtimeDir, 'knowledge'),
        source_count: 0,
        chunk_count: 0
      };
    },
    start({ on_update }) {
      on_update({
        phase: 'refreshing',
        ready: false,
        marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_REFRESHING',
        existing: { knowledge_root: path.join(runtimeDir, 'knowledge'), source_count: 0, chunk_count: 0 }
      });
      completionTimer = setTimeout(() => {
        on_update({
          phase: 'complete',
          ready: true,
          marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_PASS',
          result: { ok: true, marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_PASS' },
          existing: { knowledge_root: path.join(runtimeDir, 'knowledge'), source_count: 12, chunk_count: 34 }
        });
      }, 700);
      return { started: true };
    },
    stop() {
      stoppedWorker = true;
      if (completionTimer) clearTimeout(completionTimer);
      return true;
    }
  };

  const runtime = createChatLocalRuntime({
    host: '127.0.0.1',
    port,
    runtime_dir: runtimeDir,
    runtime: { session_id: 'startup-bootstrap-test' },
    reconcile_dream_archive: () => ({ discovered: 0, indexed: 0, already_indexed: 0, malformed: 0 }),
    live_audio_service: fakeAudio(),
    vision_reconciler: {
      async reconcile(active) { return { ok: true, active, transition: 'noop' }; }
    },
    knowledge_bootstrap: knowledgeBootstrap
  });

  const startedAt = Date.now();
  const started = await runtime.start();
  const startupElapsedMs = Date.now() - startedAt;

  assert.equal(started.api_ready, true, 'API must bind before a long knowledge refresh completes');
  assert.equal(started.brain_loaded, true);
  assert.equal(started.knowledge_refreshing, true);
  assert.equal(started.knowledge_ready, false);
  assert.ok(startupElapsedMs < 500, `runtime bootstrap took ${startupElapsedMs}ms and blocked on knowledge refresh`);

  const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.ok, true, 'status endpoint must be reachable during knowledge refresh');
  const duringRefresh = await response.json();
  assert.equal(duringRefresh.api_ready, true);
  assert.equal(duringRefresh.knowledge_refreshing, true);
  assert.equal(duringRefresh.ready, false, 'strict readiness must remain false while required knowledge is refreshing');

  const interfaceResponse = await fetch(`http://127.0.0.1:${port}/interface/status`, { signal: AbortSignal.timeout(1000) });
  assert.equal(interfaceResponse.ok, true, 'interface status must be reachable during knowledge refresh');
  const interfaceStatus = await interfaceResponse.json();
  assert.equal(interfaceStatus.connected, true);
  assert.equal(interfaceStatus.online, true, 'the authoritative brain/API must remain online while memory refreshes');
  assert.equal(interfaceStatus.fullyReady, false, 'the interface must still expose strict readiness separately');
  assert.equal(interfaceStatus.memoryLoaded, false);

  await delay(850);
  const completed = runtime.status();
  assert.equal(completed.knowledge_refreshing, false);
  assert.equal(completed.knowledge_ready, true);
  assert.equal(completed.knowledge_autoload.source_count, 12);
  assert.equal(completed.knowledge_autoload.chunk_count, 34);

  await runtime.stop();
  assert.equal(stoppedWorker, true, 'runtime shutdown must stop any knowledge worker');
  fs.rmSync(runtimeDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_STARTUP_BOOTSTRAP_PASS',
    api_bound_before_knowledge_refresh_completed: true,
    senses_held_until_client_ready: true,
    knowledge_refresh_completed_live: true,
    startup_elapsed_ms: startupElapsedMs,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_LOCAL_STARTUP_BOOTSTRAP_FAIL',
    error: error.stack || error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
