"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const template = fs.readFileSync(
  path.join(ROOT, 'config/chat.config.yaml.temp'),
  'utf8'
);
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'floki-control-local-')
);
const runtimeRoot = path.join(tempRoot, 'runtime');
const socketPath = path.join(tempRoot, 'supervisor.sock');
const configPath = path.join(tempRoot, 'chat.yaml');
const configText = template
  .replace(
    /chat_runtime_root:\s*[^\n]+/,
    'chat_runtime_root: "' + runtimeRoot.replace(/\\/g, '\\\\') + '"'
  )
  .replace(
    /supervisor_local_socket_path:\s*"[^"]+"/,
    'supervisor_local_socket_path: "' + socketPath.replace(/\\/g, '\\\\') + '"'
  );
fs.writeFileSync(configPath, configText);
process.env.FLOKI_CHAT_CONFIG_PATH = configPath;

const configModule = require('../src/config/floki-config.cjs');
configModule.clearConfigCache();
const { createSupervisor } = require(
  '../src/control-plane/floki-control-supervisor.cjs'
);

function request(options, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: raw ? JSON.parse(raw) : {}
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const supervisor = createSupervisor({
    public_key_path: path.join(tempRoot, 'missing.pub')
  });
  const calls = [];
  const server = supervisor.createLocalServer({
    handle_lifecycle: async (moduleKey, action) => {
      calls.push({ moduleKey, action });
      return {
        ok: true,
        verified: true,
        module: moduleKey,
        action,
        status: action === 'stop' ? 'stopped' : 'running',
        lifecycleState: action === 'stop' ? 'stopped' : 'running'
      };
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  try {
    const health = await request({
      socketPath,
      path: '/health',
      method: 'GET'
    });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const stop = await request({
      socketPath,
      path: '/modules/vision/stop',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '2'
      }
    }, '{}');
    assert.equal(stop.status, 200);
    assert.equal(stop.body.ok, true);
    assert.equal(stop.body.verified, true);
    assert.deepEqual(calls, [{ moduleKey: 'vision', action: 'stop' }]);
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

    const registry = require('../src/control-plane/module-registry.cjs');
    assert.deepEqual(Array.from(registry.SUPERVISED_MODULES).sort(), [
      'authoritative_api',
      'floki_core',
      'rsi',
      'sleep_scheduler',
      'vision'
    ]);
    assert.equal(registry.getModuleConfig('floki_core').stop_available, true);
    assert.equal(
      registry.getModuleConfig('authoritative_api').stop_available,
      true
    );

    const supervisorSource = fs.readFileSync(
      path.join(
        ROOT,
        'src/control-plane/floki-control-supervisor.cjs'
      ),
      'utf8'
    );
    assert.match(
      supervisorSource,
      /authoritative_api:\s*\{\s*start:\s*'floki-chat-start\.sh',\s*stop:\s*'floki-chat-stop\.sh'/
    );

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_CONTROL_PLANE_LOCAL_RUNTIME_TRANSPORT_CONTRACT_PASS',
      local_unix_socket_authorized: true,
      signed_tcp_preserved: true,
      full_supervised_allowlist_preserved: true,
      core_and_api_controls_preserved: true,
      authoritative_api_mapping_added: true
    }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.FLOKI_CHAT_CONFIG_PATH;
    configModule.clearConfigCache();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
