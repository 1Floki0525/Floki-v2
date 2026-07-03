'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const { newId } = require('../src/util/ids.cjs');

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
        'content-length': bodyBuffer.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_error) {}
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (bodyBuffer.length) req.write(bodyBuffer);
    req.end();
  });
}

function read(relPath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relPath), 'utf8');
}

function cardByKey(cards, key) {
  const card = cards.find((entry) => entry.key === key);
  assert.ok(card, 'missing card: ' + key);
  return card;
}

async function run() {
  const testRoot = path.resolve(__dirname, '..', 'state', 'floki', 'test-client-app-cards', newId('test'));
  fs.mkdirSync(testRoot, { recursive: true });

  const { clearConfigCache } = require('../src/config/floki-config.cjs');
  const tempConfigPath = path.join(testRoot, 'chat.config.yaml');
  const baseConfig = fs.readFileSync(path.resolve(__dirname, '..', 'config', 'chat.config.yaml'), 'utf8');
  const runtimePort = await findFreePort();
  fs.writeFileSync(
    tempConfigPath,
    baseConfig
      .replace(/chat_runtime_root: [^\n]+/, 'chat_runtime_root: "' + testRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')
      .replace(/runtime_port: [^\n]+/, 'runtime_port: ' + runtimePort)
  );

  process.env.FLOKI_CHAT_CONFIG_PATH = tempConfigPath;
  clearConfigCache();

  const { MODULE_KEYS, getModuleConfig } = require('../src/control-plane/module-registry.cjs');
  assert.deepEqual(MODULE_KEYS.slice(-3), ['web_app', 'mobile_app', 'rsi']);
  assert.equal(getModuleConfig('web_app').client_app, true);
  assert.equal(getModuleConfig('mobile_app').client_app, true);
  assert.equal(getModuleConfig('web_app').in_process, true);
  assert.equal(getModuleConfig('mobile_app').in_process, true);

  const { createChatLocalRuntime } = require('../src/runtime/chat-local-runtime.cjs');
  const runtime = createChatLocalRuntime({ port: runtimePort });
  await runtime.start();

  try {
    const beforeStatus = await httpRequest(runtimePort, '/status');
    assert.equal(beforeStatus.status, 200);
    const runtimePid = beforeStatus.json.pid;

    const registry = await httpRequest(runtimePort, '/control/modules');
    assert.equal(registry.status, 200);
    assert.equal(registry.json.registry.keys.length, 14);
    assert.equal(registry.json.registry.modules.length, 14);
    assert.equal(registry.json.cards.length, 14);

    const initialServices = await httpRequest(runtimePort, '/interface/services');
    assert.equal(initialServices.status, 200);
    assert.equal(initialServices.json.length, 14);
    for (const key of ['web_app', 'mobile_app']) {
      const card = cardByKey(initialServices.json, key);
      assert.equal(card.clientApp, true);
      assert.equal(card.logAvailable, false);
      assert.equal(card.logKey, null);
      assert.equal(card.startAvailable, true);
      assert.equal(card.stopAvailable, true);
      assert.equal(card.resetAvailable, true);
      assert.equal(typeof card.controlGeneration, 'number');
    }

    for (const app of ['web_app', 'mobile_app']) {
      const heartbeat = await httpRequest(runtimePort, '/interface/client-app/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          app_key: app,
          client_id: app + '-client-0001',
          session_id: app + '-session-0001',
          transport_type: app === 'web_app' ? 'http-web' : 'android-http',
          healthy: true
        })
      });
      assert.equal(heartbeat.status, 200);
      assert.equal(heartbeat.json.status, 'running');
    }

    let services = (await httpRequest(runtimePort, '/interface/services')).json;
    assert.equal(cardByKey(services, 'web_app').lifecycleState, 'running');
    assert.equal(cardByKey(services, 'mobile_app').lifecycleState, 'running');

    const webStop = await httpRequest(runtimePort, '/control/modules/web_app/stop', { method: 'POST', body: '{}' });
    assert.equal(webStop.status, 200);
    assert.equal(webStop.json.health.runtime_pid_preserved, true);
    assert.equal(webStop.json.status, 'stopped');

    const recoveryHeartbeat = await httpRequest(runtimePort, '/interface/client-app/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        app_key: 'web_app',
        client_id: 'web_app-client-0001',
        session_id: 'web_app-session-0001',
        transport_type: 'http-web',
        healthy: true
      })
    });
    assert.equal(recoveryHeartbeat.status, 200);
    assert.equal(recoveryHeartbeat.json.status, 'stopped');
    services = (await httpRequest(runtimePort, '/interface/services')).json;
    assert.equal(cardByKey(services, 'web_app').lifecycleState, 'stopped');

    const webStart = await httpRequest(runtimePort, '/control/modules/web_app/start', { method: 'POST', body: '{}' });
    assert.equal(webStart.status, 200);
    assert.equal(webStart.json.status, 'running');

    services = (await httpRequest(runtimePort, '/interface/services')).json;
    const beforeMobileGeneration = cardByKey(services, 'mobile_app').controlGeneration;
    const mobileReset = await httpRequest(runtimePort, '/control/modules/mobile_app/reset', { method: 'POST', body: '{}' });
    assert.equal(mobileReset.status, 200);
    assert.equal(mobileReset.json.generation, beforeMobileGeneration + 1);
    assert.equal(mobileReset.json.status, 'degraded');

    services = (await httpRequest(runtimePort, '/interface/services')).json;
    assert.equal(cardByKey(services, 'mobile_app').healthyClientCount, 0);
    assert.equal(cardByKey(services, 'mobile_app').controlGeneration, beforeMobileGeneration + 1);

    const freshMobileHeartbeat = await httpRequest(runtimePort, '/interface/client-app/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        app_key: 'mobile_app',
        client_id: 'mobile_app-client-0002',
        session_id: 'mobile_app-session-0002',
        transport_type: 'android-http',
        healthy: true
      })
    });
    assert.equal(freshMobileHeartbeat.status, 200);
    assert.equal(freshMobileHeartbeat.json.status, 'running');

    const afterStatus = await httpRequest(runtimePort, '/status');
    assert.equal(afterStatus.status, 200);
    assert.equal(afterStatus.json.pid, runtimePid);

    assert.match(read('apps/floki-neural-interface/src/integrations/floki/adapter.js'), /clientAppHeartbeat[\s\S]*controlModule[\s\S]*\/control\/modules\//);
    assert.match(read('apps/floki-neural-interface/electron/main.cjs'), /floki:control-module[\s\S]*\/interface\/client-app\/heartbeat/);
    assert.match(read('apps/floki-neural-interface/electron/preload.cjs'), /controlModule[\s\S]*clientAppHeartbeat/);
    assert.match(read('apps/floki-neural-interface/src/components/system/ServiceCard.jsx'), /Start[\s\S]*Stop[\s\S]*Restart/);
    assert.match(read('apps/floki-neural-interface/src/pages/SystemDashboard.jsx'), /controlModule\(service\.key,\s*action\)/);
    const mobileViewModel = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt');
    assert.match(mobileViewModel, /MOBILE_APP_KEY/);
    assert.match(mobileViewModel, /\/interface\/client-app\/heartbeat/);
    assert.match(mobileViewModel, /fun controlModule\(/);
    assert.match(read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt'), /controlModule\(service\.key,\s*"start"\)[\s\S]*controlModule\(service\.key,\s*"stop"\)[\s\S]*controlModule\(service\.key,\s*"reset"\)/);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CLIENT_APP_SYSTEM_CARDS_CONTRACT_PASS',
      cards: 14,
      runtime_pid_preserved: true
    }, null, 2));
  } finally {
    try { await runtime.stop(); } catch (_error) {}
    delete process.env.FLOKI_CHAT_CONFIG_PATH;
    clearConfigCache();
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CLIENT_APP_SYSTEM_CARDS_CONTRACT_FAIL',
    error: error.message,
    stack: error.stack
  }, null, 2));
  process.exit(1);
});
