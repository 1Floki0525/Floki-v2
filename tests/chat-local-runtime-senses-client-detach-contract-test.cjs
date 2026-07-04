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
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function lifecycle(awake) {
  return Object.freeze({
    is_awake: awake === true,
    is_asleep: awake !== true,
    phase: awake === true ? 'awake' : 'sleeping',
    source: 'contract'
  });
}

function recordingAudio(calls) {
  let requestedAwake = false;
  return Object.freeze({
    async start() { calls.push(['audio.start']); return this.status(); },
    async stop() { calls.push(['audio.stop']); requestedAwake = false; return this.status(); },
    async setAwake(value) {
      requestedAwake = value === true;
      calls.push(['audio.setAwake', requestedAwake]);
      return this.status();
    },
    status() {
      return Object.freeze({
        service_state: requestedAwake ? 'requested_listening' : 'sleeping',
        awake: requestedAwake,
        speaking: false,
        microphone_open: false,
        vad_ready: false,
        whisper_ready: false,
        piper_ready: true,
        playback_ready: true,
        last_error: null,
        last_wake_gate_error: null,
        last_heartbeat_at: new Date().toISOString()
      });
    },
    speak: async () => ({ ok: true }),
    interruptSpeech: async () => ({ ok: true })
  });
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1000)
  });
  assert.equal(response.ok, true, url);
  return response.json();
}

async function run() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-client-detach-senses-'));
  const port = await freePort();
  const audioCalls = [];
  const visionCalls = [];
  let awake = true;

  const runtime = createChatLocalRuntime({
    host: '127.0.0.1',
    port,
    runtime_dir: runtimeDir,
    runtime: { session_id: 'client-detach-senses-contract' },
    lifecycle_status_provider: () => lifecycle(awake),
    reconcile_dream_archive: () => ({ discovered: 0, indexed: 0, already_indexed: 0, malformed: 0 }),
    knowledge_bootstrap: {
      inspect: () => ({ ok: true, ready: true, marker: 'FLOKI_TEST_KNOWLEDGE_READY', source_count: 0, chunk_count: 0 }),
      start: () => ({ started: false }),
      stop: () => true
    },
    live_audio_service: recordingAudio(audioCalls),
    vision_reconciler: {
      async reconcile(active, metadata) {
        visionCalls.push(['vision.reconcile', active === true, metadata && metadata.awake === true]);
        return { ok: true, active: active === true };
      }
    }
  });

  try {
    const started = await runtime.start();
    assert.equal(started.pid, process.pid);
    assert.equal(started.client_ready, false);
    assert.equal(started.senses_allowed, true);
    assert.deepEqual(audioCalls.at(-1), ['audio.setAwake', true]);
    assert.deepEqual(visionCalls.at(-1), ['vision.reconcile', true, true]);

    await postJson(`http://127.0.0.1:${port}/client-ready`);
    assert.equal(runtime.status().client_ready, true);
    assert.deepEqual(audioCalls.at(-1), ['audio.setAwake', true]);
    assert.deepEqual(visionCalls.at(-1), ['vision.reconcile', true, true]);

    await postJson(`http://127.0.0.1:${port}/client-detached`);
    const detached = runtime.status();
    assert.equal(detached.client_ready, false);
    assert.equal(detached.window_visible, false);
    assert.equal(detached.senses_allowed, true);
    assert.equal(detached.hearing_intentionally_suspended, false);
    assert.equal(detached.vision_intentionally_suspended, false);
    assert.deepEqual(audioCalls.at(-1), ['audio.setAwake', true]);
    assert.deepEqual(visionCalls.at(-1), ['vision.reconcile', true, true]);

    awake = false;
    await postJson(`http://127.0.0.1:${port}/settings/reload`);
    await delay(20);
    const sleeping = runtime.status();
    assert.equal(sleeping.senses_allowed, false);
    assert.equal(sleeping.hearing_intentionally_suspended, true);
    assert.equal(sleeping.vision_intentionally_suspended, true);
    assert.deepEqual(audioCalls.at(-1), ['audio.setAwake', false]);
    assert.deepEqual(visionCalls.at(-1), ['vision.reconcile', false, false]);

    awake = true;
    await postJson(`http://127.0.0.1:${port}/settings/reload`);
    await delay(20);
    const rewoken = runtime.status();
    assert.equal(rewoken.senses_allowed, true);
    assert.equal(rewoken.hearing_intentionally_suspended, false);
    assert.equal(rewoken.vision_intentionally_suspended, false);
    assert.deepEqual(audioCalls.at(-1), ['audio.setAwake', true]);
    assert.deepEqual(visionCalls.at(-1), ['vision.reconcile', true, true]);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_RUNTIME_SENSES_SURVIVE_CLIENT_DETACH_PASS',
      runtime_pid_preserved: true,
      client_presence_is_telemetry_only: true,
      sleep_stops_senses: true,
      wake_restarts_senses: true,
      fake_camera_or_microphone_readiness: false
    }, null, 2));
  } finally {
    await runtime.stop();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_RUNTIME_SENSES_SURVIVE_CLIENT_DETACH_FAIL',
    error: error.stack || error.message
  }, null, 2));
  process.exit(1);
});
