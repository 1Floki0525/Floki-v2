'use strict';

/**
 * Control-plane lifecycle route contract test.
 *
 * Proves the runtime exposes:
 *   GET  /control/modules
 *   POST /control/modules/{module}/start|stop|reset
 *
 * Uses a mocked supervisor so production processes are never touched.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const { newId } = require('../src/util/ids.cjs');
const { buildAuthorizationHeader } = require('../src/control-plane/sign-request.cjs');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const pubDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const rawPublic = pubDer.subarray(spkiPrefix.length);
  return { privateKey: crypto.createPrivateKey(privateKey), publicKey: rawPublic };
}

function signWithPem(privateKeyPem, method, moduleKey, action, bodyBuffer) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.createHash('sha256').update(bodyBuffer).digest('base64url');
  const message = [method, moduleKey, action, timestamp, nonce, hash].join('|');
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), keyObject);
  return 'floki-ed25519 ' +
    'module=' + moduleKey + ';' +
    'action=' + action + ';' +
    'timestamp=' + timestamp + ';' +
    'nonce=' + nonce + ';' +
    'signature=' + signature.toString('base64url');
}

function httpRequest(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = options.body ? Buffer.from(options.body, 'utf8') : Buffer.alloc(0);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'content-length': bodyBuffer.length,
        ...(options.headers || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_error) { /* keep null */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

async function run() {
  const testRoot = path.resolve(__dirname, '..', 'state', 'floki', 'test-control-lifecycle', newId('test'));
  fs.mkdirSync(testRoot, { recursive: true });

  const { clearConfigCache } = require('../src/config/floki-config.cjs');
  const tempConfigPath = path.join(testRoot, 'chat.config.yaml');
  const baseConfig = fs.readFileSync(path.resolve(__dirname, '..', 'config', 'chat.config.yaml'), 'utf8');
  fs.writeFileSync(tempConfigPath, baseConfig);

  function patchConfigFile(runtimePort, supervisorPort) {
    let text = fs.readFileSync(tempConfigPath, 'utf8');
    const pubKeyPath = path.join(testRoot, 'supervisor.pub').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const runtimeRoot = testRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    text = text.replace(/chat_runtime_root: [^\n]+/, 'chat_runtime_root: "' + runtimeRoot + '"');
    text = text.replace(/runtime_port: [^\n]+/, 'runtime_port: ' + runtimePort);
    text = text.replace(/supervisor_port: [^\n]+/, 'supervisor_port: ' + supervisorPort);
    if (!text.includes('supervisor_public_key_path:')) {
      text = text.replace(/lifecycle_verify_poll_ms: 500/, 'lifecycle_verify_poll_ms: 500\n  supervisor_public_key_path: "' + pubKeyPath + '"');
    } else {
      text = text.replace(/supervisor_public_key_path: "[^"]+"/, 'supervisor_public_key_path: "' + pubKeyPath + '"');
    }
    fs.writeFileSync(tempConfigPath, text);
  }

  const supervisorPort = await findFreePort();
  const runtimePort = await findFreePort();
  patchConfigFile(runtimePort, supervisorPort);

  process.env.FLOKI_CHAT_CONFIG_PATH = tempConfigPath;
  clearConfigCache();

  const { privateKey, publicKey } = generateKeypair();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(testRoot, 'supervisor.pub'), publicKey.toString('base64') + '\n');
  fs.writeFileSync(path.join(testRoot, 'supervisor.key'), privateKeyPem, { mode: 0o600 });
  process.env.FLOKI_CONTROL_PLANE_PRIVATE_KEY_PATH = path.join(testRoot, 'supervisor.key');

  const supervisorOperations = [];
  const supervisorServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const lifecycleMatch = url.pathname.match(/^\/modules\/([a-z_][a-z0-9_]*)\/(start|stop|reset)$/);
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      const body = JSON.stringify({ ok: true, marker: 'mock-supervisor-health' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (!lifecycleMatch) {
      const body = JSON.stringify({ ok: false, error: 'not found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const moduleKey = lifecycleMatch[1];
    const action = lifecycleMatch[2];
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('floki-ed25519 ')) {
        const out = JSON.stringify({ ok: false, error: 'missing authorization' });
        res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
        return;
      }
      supervisorOperations.push({ module: moduleKey, action, auth: auth.slice(0, 40) + '...' });
      const out = JSON.stringify({
        ok: true,
        module: moduleKey,
        action,
        changed: true,
        previousStatus: 'stopped',
        status: action === 'stop' ? 'stopped' : 'running',
        lifecycleState: action === 'stop' ? 'stopped' : 'running',
        health: { ok: true },
        message: moduleKey + ' ' + action + ' performed by mock supervisor',
        safeError: null,
        operationId: newId('op'),
        generation: 1
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out), 'cache-control': 'no-store' });
      res.end(out);
    });
  });

  await new Promise((resolve, reject) => {
    supervisorServer.once('error', reject);
    supervisorServer.listen(supervisorPort, '127.0.0.1', () => {
      supervisorServer.removeListener('error', reject);
      resolve();
    });
  });

  const { createChatLocalRuntime } = require('../src/runtime/chat-local-runtime.cjs');
  const runtime = createChatLocalRuntime({ port: runtimePort });
  await runtime.start();

  try {
    // 1. GET /control/modules returns registry metadata.
    const registry = await httpRequest(runtimePort, '/control/modules');
    assert.equal(registry.status, 200);
    assert.equal(registry.json.ok, true);
    assert.ok(registry.json.registry);
    assert.equal(registry.json.registry.keys.length, 12);
    assert.equal(registry.json.registry.modules.length, 12);
    assert.equal(registry.json.registry.actions.allowed_actions.length, 3);

    const services = await httpRequest(runtimePort, '/interface/services');
    assert.equal(services.status, 200);
    assert.equal(Array.isArray(services.json), true);
    assert.equal(services.json.length, 12);
    assert.equal(registry.json.cards.length, 12);
    const controlCards = new Map(registry.json.cards.map((card) => [card.key, card]));
    for (const service of services.json) {
      const controlCard = controlCards.get(service.key);
      assert.ok(controlCard, 'missing control card for ' + service.key);
      for (const field of [
        'key', 'name', 'status', 'lifecycleState', 'startAvailable',
        'stopAvailable', 'resetAvailable', 'logAvailable', 'logKey',
        'requiresConfirmation', 'dependencyWarning', 'lastHeartbeat',
        'uptime', 'latency', 'detail', 'lastError'
      ]) {
        assert.equal(Object.hasOwn(controlCard, field), true, service.key + ' missing ' + field);
      }
      assert.equal(controlCard.status, service.status);
      assert.equal(controlCard.lifecycleState, service.lifecycleState);
      assert.equal(controlCard.logKey, service.logKey);
    }

    // 2. Cognition has a real in-process Stop -> blocked chat -> Start -> Reset lifecycle.
    const cognitionStop = await httpRequest(runtimePort, '/control/modules/cognition/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(cognitionStop.status, 200);
    assert.equal(cognitionStop.json.ok, true);
    assert.equal(cognitionStop.json.module, 'cognition');
    assert.equal(cognitionStop.json.action, 'stop');
    assert.equal(cognitionStop.json.changed, true);
    assert.equal(cognitionStop.json.status, 'stopped');
    assert.equal(cognitionStop.json.lifecycleState, 'stopped');
    assert.equal(cognitionStop.json.health.runtime_pid_preserved, true);
    assert.equal(cognitionStop.json.health.cognition_enabled, false);

    const blockedChat = await httpRequest(runtimePort, '/chat', {
      method: 'POST',
      body: JSON.stringify({ text: 'This request must not reach cognition.' })
    });
    assert.equal(blockedChat.status, 503);
    assert.equal(blockedChat.json.ok, false);
    assert.equal(blockedChat.json.status, 'stopped');
    assert.equal(blockedChat.json.lifecycleState, 'stopped');
    assert.match(blockedChat.json.error, /Cognition is stopped/);

    const cognitionStart = await httpRequest(runtimePort, '/control/modules/cognition/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(cognitionStart.status, 200);
    assert.equal(cognitionStart.json.ok, true);
    assert.equal(cognitionStart.json.module, 'cognition');
    assert.equal(cognitionStart.json.action, 'start');
    assert.equal(cognitionStart.json.changed, true);
    assert.equal(cognitionStart.json.status, 'running');
    assert.equal(cognitionStart.json.lifecycleState, 'running');
    assert.equal(cognitionStart.json.health.runtime_pid_preserved, true);
    assert.equal(cognitionStart.json.health.cognition_enabled, true);

    const cognitionReset = await httpRequest(runtimePort, '/control/modules/cognition/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(cognitionReset.status, 200);
    assert.equal(cognitionReset.json.ok, true);
    assert.equal(cognitionReset.json.module, 'cognition');
    assert.equal(cognitionReset.json.action, 'reset');
    assert.equal(cognitionReset.json.changed, true);
    assert.equal(cognitionReset.json.status, 'running');
    assert.equal(cognitionReset.json.lifecycleState, 'running');
    assert.equal(cognitionReset.json.health.runtime_pid_preserved, true);
    assert.equal(cognitionReset.json.health.cognition_enabled, true);

    // 2b. Hearing controls the real live-audio gate without bypassing client/sleep gates.
    const hearingStop = await httpRequest(runtimePort, '/control/modules/hearing/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(hearingStop.status, 200);
    assert.equal(hearingStop.json.ok, true);
    assert.equal(hearingStop.json.module, 'hearing');
    assert.equal(hearingStop.json.action, 'stop');
    assert.equal(hearingStop.json.health.runtime_pid_preserved, true);
    assert.equal(hearingStop.json.health.hearing_enabled, false);
    assert.equal(hearingStop.json.health.microphone_open, false);
    assert.equal(hearingStop.json.status, 'stopped');

    const hearingStart = await httpRequest(runtimePort, '/control/modules/hearing/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(hearingStart.status, 200);
    assert.equal(hearingStart.json.ok, true);
    assert.equal(hearingStart.json.module, 'hearing');
    assert.equal(hearingStart.json.action, 'start');
    assert.equal(hearingStart.json.health.runtime_pid_preserved, true);
    assert.equal(hearingStart.json.health.hearing_enabled, true);
    assert.equal(hearingStart.json.health.activation_required, false);
    assert.equal(hearingStart.json.health.microphone_open, false);
    assert.equal(hearingStart.json.status, 'stopped');

    const hearingReset = await httpRequest(runtimePort, '/control/modules/hearing/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(hearingReset.status, 200);
    assert.equal(hearingReset.json.ok, true);
    assert.equal(hearingReset.json.module, 'hearing');
    assert.equal(hearingReset.json.action, 'reset');
    assert.equal(hearingReset.json.changed, true);
    assert.equal(hearingReset.json.health.runtime_pid_preserved, true);
    assert.equal(hearingReset.json.health.hearing_enabled, true);
    assert.equal(hearingReset.json.health.activation_required, false);
    assert.equal(hearingReset.json.health.microphone_open, false);
    assert.equal(hearingReset.json.status, 'stopped');

    // 3. Supervised module lifecycle delegates to the mock supervisor.
    const visionStop = await httpRequest(runtimePort, '/control/modules/vision/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(visionStop.status, 200);
    assert.equal(visionStop.json.ok, true);
    assert.equal(visionStop.json.module, 'vision');
    assert.equal(visionStop.json.action, 'stop');
    assert.equal(supervisorOperations.some((op) => op.module === 'vision' && op.action === 'stop'), true);

    // 4. Unknown module returns safe 404.
    const unknown = await httpRequest(runtimePort, '/control/modules/unknown_module/start', {
      method: 'POST',
      body: '{}'
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.ok, false);

    // 5. Unknown action returns safe error.
    const badAction = await httpRequest(runtimePort, '/control/modules/cognition/pause', {
      method: 'POST',
      body: '{}'
    });
    assert.equal(badAction.status, 404);

    // 6. Floki Core advertises strong confirmation, but Stop is not
    // exercised until the independent supervisor recovery path is installed.
    const coreCard = controlCards.get('floki_core');
    assert.equal(coreCard.requiresConfirmation, true);


    // 7. Speech controls the real Piper output gate and preserves the runtime PID.
    const speechStop = await httpRequest(runtimePort, '/control/modules/speech/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(speechStop.status, 200);
    assert.equal(speechStop.json.ok, true);
    assert.equal(speechStop.json.module, 'speech');
    assert.equal(speechStop.json.action, 'stop');
    assert.equal(speechStop.json.health.runtime_pid_preserved, true);
    assert.equal(speechStop.json.health.speech_enabled, false);
    assert.equal(speechStop.json.health.speaking, false);
    assert.equal(speechStop.json.status, 'stopped');

    const speechStart = await httpRequest(runtimePort, '/control/modules/speech/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(speechStart.status, 200);
    assert.equal(speechStart.json.ok, true);
    assert.equal(speechStart.json.module, 'speech');
    assert.equal(speechStart.json.action, 'start');
    assert.equal(speechStart.json.health.runtime_pid_preserved, true);
    assert.equal(speechStart.json.health.speech_enabled, true);

    const speechReset = await httpRequest(runtimePort, '/control/modules/speech/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(speechReset.status, 200);
    assert.equal(speechReset.json.ok, true);
    assert.equal(speechReset.json.module, 'speech');
    assert.equal(speechReset.json.action, 'reset');
    assert.equal(speechReset.json.changed, true);
    assert.equal(speechReset.json.health.runtime_pid_preserved, true);
    assert.equal(speechReset.json.health.speech_enabled, true);
    assert.equal(speechReset.json.health.speaking, false);

    // 7b. Memory controls the real persistent-memory and knowledge-refresh gates.
    const memoryStop = await httpRequest(runtimePort, '/control/modules/memory/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(memoryStop.status, 200);
    assert.equal(memoryStop.json.ok, true);
    assert.equal(memoryStop.json.module, 'memory');
    assert.equal(memoryStop.json.action, 'stop');
    assert.equal(memoryStop.json.health.runtime_pid_preserved, true);
    assert.equal(memoryStop.json.health.memory_enabled, false);
    assert.equal(memoryStop.json.health.knowledge_worker_running, false);
    assert.equal(memoryStop.json.status, 'stopped');

    const memoryStart = await httpRequest(runtimePort, '/control/modules/memory/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(memoryStart.status, 200);
    assert.equal(memoryStart.json.ok, true);
    assert.equal(memoryStart.json.module, 'memory');
    assert.equal(memoryStart.json.action, 'start');
    assert.equal(memoryStart.json.health.runtime_pid_preserved, true);
    assert.equal(memoryStart.json.health.memory_enabled, true);
    assert.equal(memoryStart.json.health.memory_loaded, true);
    assert.equal(memoryStart.json.status, 'running');

    const memoryReset = await httpRequest(runtimePort, '/control/modules/memory/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(memoryReset.status, 200);
    assert.equal(memoryReset.json.ok, true);
    assert.equal(memoryReset.json.module, 'memory');
    assert.equal(memoryReset.json.action, 'reset');
    assert.equal(memoryReset.json.changed, true);
    assert.equal(memoryReset.json.health.runtime_pid_preserved, true);
    assert.equal(memoryReset.json.health.memory_enabled, true);
    assert.equal(memoryReset.json.health.memory_loaded, true);
    assert.equal(memoryReset.json.status, 'running');

    // 7c. Emotion freezes and restores real affect/reinforcement updates.
    const emotionStop = await httpRequest(runtimePort, '/control/modules/emotion/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(emotionStop.status, 200);
    assert.equal(emotionStop.json.ok, true);
    assert.equal(emotionStop.json.module, 'emotion');
    assert.equal(emotionStop.json.action, 'stop');
    assert.equal(emotionStop.json.health.runtime_pid_preserved, true);
    assert.equal(emotionStop.json.health.emotion_enabled, false);
    assert.equal(emotionStop.json.status, 'stopped');

    const emotionStart = await httpRequest(runtimePort, '/control/modules/emotion/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(emotionStart.status, 200);
    assert.equal(emotionStart.json.ok, true);
    assert.equal(emotionStart.json.module, 'emotion');
    assert.equal(emotionStart.json.action, 'start');
    assert.equal(emotionStart.json.health.runtime_pid_preserved, true);
    assert.equal(emotionStart.json.health.emotion_enabled, true);
    assert.equal(emotionStart.json.status, 'running');

    const emotionReset = await httpRequest(runtimePort, '/control/modules/emotion/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(emotionReset.status, 200);
    assert.equal(emotionReset.json.ok, true);
    assert.equal(emotionReset.json.module, 'emotion');
    assert.equal(emotionReset.json.action, 'reset');
    assert.equal(emotionReset.json.changed, true);
    assert.equal(emotionReset.json.health.runtime_pid_preserved, true);
    assert.equal(emotionReset.json.health.emotion_enabled, true);
    assert.equal(emotionReset.json.status, 'running');

    // 7d. Live Event Stream owns the real WebSocket delivery gate.
    const streamStop = await httpRequest(runtimePort, '/control/modules/live_event_stream/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(streamStop.status, 200);
    assert.equal(streamStop.json.ok, true);
    assert.equal(streamStop.json.module, 'live_event_stream');
    assert.equal(streamStop.json.action, 'stop');
    assert.equal(streamStop.json.health.runtime_pid_preserved, true);
    assert.equal(streamStop.json.health.live_event_stream_enabled, false);
    assert.equal(streamStop.json.health.websocket_ready, false);
    assert.equal(streamStop.json.health.websocket_clients, 0);
    assert.equal(streamStop.json.status, 'stopped');

    const streamStart = await httpRequest(runtimePort, '/control/modules/live_event_stream/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(streamStart.status, 200);
    assert.equal(streamStart.json.ok, true);
    assert.equal(streamStart.json.module, 'live_event_stream');
    assert.equal(streamStart.json.action, 'start');
    assert.equal(streamStart.json.health.runtime_pid_preserved, true);
    assert.equal(streamStart.json.health.live_event_stream_enabled, true);
    assert.equal(streamStart.json.health.websocket_ready, true);
    assert.equal(streamStart.json.status, 'running');

    const streamReset = await httpRequest(runtimePort, '/control/modules/live_event_stream/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(streamReset.status, 200);
    assert.equal(streamReset.json.ok, true);
    assert.equal(streamReset.json.module, 'live_event_stream');
    assert.equal(streamReset.json.action, 'reset');
    assert.equal(streamReset.json.changed, true);
    assert.equal(streamReset.json.health.runtime_pid_preserved, true);
    assert.equal(streamReset.json.health.live_event_stream_enabled, true);
    assert.equal(streamReset.json.health.websocket_ready, true);
    assert.equal(streamReset.json.status, 'running');

    // 7e. Dream Engine owns an independent shared generation gate.
    const dreamStop = await httpRequest(runtimePort, '/control/modules/dream_engine/stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(dreamStop.status, 200);
    assert.equal(dreamStop.json.ok, true);
    assert.equal(dreamStop.json.module, 'dream_engine');
    assert.equal(dreamStop.json.action, 'stop');
    assert.equal(dreamStop.json.health.runtime_pid_preserved, true);
    assert.equal(dreamStop.json.health.dream_engine_enabled, false);
    assert.equal(dreamStop.json.health.control_persisted, true);
    assert.equal(dreamStop.json.status, 'stopped');
    assert.equal(typeof dreamStop.json.generation, 'number');
    assert.ok(dreamStop.json.generation >= 1);

    const dreamStart = await httpRequest(runtimePort, '/control/modules/dream_engine/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(dreamStart.status, 200);
    assert.equal(dreamStart.json.ok, true);
    assert.equal(dreamStart.json.module, 'dream_engine');
    assert.equal(dreamStart.json.action, 'start');
    assert.equal(dreamStart.json.health.runtime_pid_preserved, true);
    assert.equal(dreamStart.json.health.dream_engine_enabled, true);
    assert.equal(dreamStart.json.health.control_persisted, true);
    assert.equal(dreamStart.json.status, 'running');
    assert.ok(dreamStart.json.generation > dreamStop.json.generation);

    const dreamReset = await httpRequest(runtimePort, '/control/modules/dream_engine/reset', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' })
    });
    assert.equal(dreamReset.status, 200);
    assert.equal(dreamReset.json.ok, true);
    assert.equal(dreamReset.json.module, 'dream_engine');
    assert.equal(dreamReset.json.action, 'reset');
    assert.equal(dreamReset.json.changed, true);
    assert.equal(dreamReset.json.health.runtime_pid_preserved, true);
    assert.equal(dreamReset.json.health.dream_engine_enabled, true);
    assert.equal(dreamReset.json.health.control_persisted, true);
    assert.equal(dreamReset.json.status, 'running');
    assert.ok(dreamReset.json.generation > dreamStart.json.generation);

    // 8. The response shape for supervisor delegation matches the in-process shape.
    assert.equal(typeof visionStop.json.changed, 'boolean');
    assert.equal(typeof visionStop.json.previousStatus, 'string');
    assert.equal(typeof visionStop.json.status, 'string');
    assert.equal(typeof visionStop.json.lifecycleState, 'string');
    assert.equal(typeof visionStop.json.operationId, 'string');

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CONTROL_PLANE_LIFECYCLE_CONTRACT_PASS',
      tests: [
        'control_modules_metadata',
        'services_control_status_consistency',
        'in_process_lifecycle',
        'supervisor_delegation',
        'unknown_module_404',
        'unknown_action_404',
        'floki_core_confirmation_metadata',
        'runtime_pid_preserved',
        'response_shape'
      ]
    }, null, 2));
  } finally {
    try { await runtime.stop(); } catch (_error) { /* ignore */ }
    await new Promise((resolve) => supervisorServer.close(resolve));
    delete process.env.FLOKI_CONTROL_PLANE_PRIVATE_KEY_PATH;
    delete process.env.FLOKI_CHAT_CONFIG_PATH;
    clearConfigCache();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await run();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CONTROL_PLANE_LIFECYCLE_CONTRACT_FAIL',
      error: error.message,
      stack: error.stack
    }, null, 2));
    process.exit(1);
  }
})();
