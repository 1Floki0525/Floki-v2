#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(
  process.env.FLOKI_GATEWAY_SOURCE_DIR ||
  path.join(ROOT, 'apps', 'floki-gateway')
);
const NODE = process.env.FLOKI_GATEWAY_NODE || process.execPath;
const INDEX = path.join(SOURCE_DIR, 'index.js');
const SESSION = path.join(SOURCE_DIR, 'gateway-session.cjs');

function marker(name, detail = '') {
  process.stdout.write(`${name}${detail ? ` ${detail}` : ''}\n`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined
      ? null
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
    const headers = { ...(options.headers || {}) };
    if (body !== null) {
      headers['Content-Type'] ||= 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json
        });
      });
    });
    req.once('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error(`request timeout for ${pathname}`));
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

function websocketHandshake(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port
    });
    let response = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        const statusLine = response.split('\r\n', 1)[0] || '';
        const match = statusLine.match(/^HTTP\/1\.1\s+(\d{3})/);
        resolve({
          status: match ? Number(match[1]) : 0,
          response
        });
      }
    };

    socket.setTimeout(10000, () => finish(new Error(`websocket timeout for ${pathname}`)));
    socket.once('error', finish);
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n\r\n')) finish();
    });
    socket.once('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const requestHeaders = {
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers
      };
      const block = Object.entries(requestHeaders)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n');
      socket.write(`GET ${pathname} HTTP/1.1\r\n${block}\r\n\r\n`);
    });
  });
}

async function waitForGateway(port, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const startupOutput = output.join('').trim();
      throw new Error(
        `gateway exited early with code ${child.exitCode}` +
        (startupOutput ? `\n--- gateway startup output ---\n${startupOutput}` : '')
      );
    }
    try {
      const health = await request(port, '/health');
      if (health.status === 200) return;
    } catch {
      // Retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const startupOutput = output.join('').trim();
  throw new Error(
    'gateway did not become healthy' +
    (startupOutput ? `\n--- gateway startup output ---\n${startupOutput}` : '')
  );
}

function makeToken(privateKey, claims) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf-8');
  const payloadB64 = payload.toString('base64');
  const signature = crypto.sign(undefined, payload, privateKey).toString('base64');
  return `${payloadB64}.${signature}`;
}

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

function countRequests(records, predicate) {
  return records.filter(predicate).length;
}

async function main() {
  assert.equal(fs.existsSync(INDEX), true, `missing gateway index: ${INDEX}`);
  assert.equal(fs.existsSync(SESSION), true, `missing gateway session module: ${SESSION}`);

  const indexSource = fs.readFileSync(INDEX, 'utf-8');
  assert.doesNotMatch(
    indexSource,
    /app\.use\s*\(\s*\/\^/,
    'regex-mounted Express authorization middleware must not return'
  );
  assert.match(
    indexSource,
    /app\.use\s*\(\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)\s*=>/,
    'plain app.use authorization middleware is required'
  );
  assert.match(indexSource, /req\.path\s*===\s*['"]\/health['"]/);
  marker('FLOKI_GATEWAY_FULL_PATH_MIDDLEWARE_SOURCE_PASS');

  const backendPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const records = [];
  const wsRecords = [];

  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      let body = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = bodyText;
      }
      records.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Authorization', 'Bearer upstream-must-not-leak');
      res.setHeader('Set-Cookie', 'upstream_session=must-not-leak');
      if (req.url.split('?')[0] === '/self-improvement/pause') {
        res.end(JSON.stringify({
          ok: true,
          token: body && body.token,
          nested: {
            approval_token: body && body.token,
            message: `received:${body && body.token}`
          }
        }));
        return;
      }

      res.end(JSON.stringify({
        ok: true,
        method: req.method,
        path: req.url,
        body
      }));
    });
  });

  backend.on('upgrade', (req, socket) => {
    wsRecords.push({
      url: req.url,
      headers: { ...req.headers }
    });
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );
    setTimeout(() => socket.destroy(), 25).unref();
  });

  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(backendPort, '127.0.0.1', resolve);
  });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-gateway-e2e-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicRaw = publicDer.subarray(publicDer.length - 32);
  const issuer = 'floki-gateway-e2e';
  const audience = 'floki-public-api-e2e';
  const internalRsiToken = crypto.randomBytes(32).toString('base64url');

  fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
    publicKey: publicRaw.toString('base64'),
    issuer,
    audience,
    proxyTarget: `http://127.0.0.1:${backendPort}`
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(tempRoot, '.rsi-token'), `${internalRsiToken}\n`, {
    mode: 0o600
  });

  const now = Math.floor(Date.now() / 1000);
  const ownerToken = makeToken(privateKey, {
    iss: issuer,
    aud: audience,
    sub: 'owner-fixture',
    role: 'owner',
    status: 'active',
    nbf: now - 5,
    exp: now + 600
  });
  const userToken = makeToken(privateKey, {
    iss: issuer,
    aud: audience,
    sub: 'user-fixture',
    role: 'user',
    status: 'approved',
    nbf: now - 5,
    exp: now + 600
  });
  const pendingToken = makeToken(privateKey, {
    iss: issuer,
    aud: audience,
    sub: 'pending-fixture',
    role: 'user',
    status: 'pending',
    exp: now + 600
  });
  const expiredToken = makeToken(privateKey, {
    iss: issuer,
    aud: audience,
    sub: 'expired-fixture',
    role: 'owner',
    status: 'active',
    exp: now - 1
  });

  const output = [];
  const gateway = spawn(NODE, [INDEX], {
    cwd: SOURCE_DIR,
    env: {
      ...process.env,
      FLOKI_GATEWAY_CONFIG_DIR: tempRoot,
      FLOKI_GATEWAY_PORT: String(gatewayPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  gateway.stdout.on('data', (chunk) => output.push(chunk.toString('utf-8')));
  gateway.stderr.on('data', (chunk) => output.push(chunk.toString('utf-8')));

  let succeeded = false;
  try {
    await waitForGateway(gatewayPort, gateway, output);

    const health = await request(gatewayPort, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json && health.json.status, 'ok');
    marker('FLOKI_GATEWAY_HEALTH_UNAUTHENTICATED_PASS');

    const missing = await request(gatewayPort, '/auth/session');
    assert.equal(missing.status, 401);
    const invalid = await request(gatewayPort, '/auth/session', {
      headers: authorization('invalid-token')
    });
    assert.equal(invalid.status, 401);
    const expired = await request(gatewayPort, '/auth/session', {
      headers: authorization(expiredToken)
    });
    assert.equal(expired.status, 401);
    const pending = await request(gatewayPort, '/auth/session', {
      headers: authorization(pendingToken)
    });
    assert.equal(pending.status, 401);
    marker('FLOKI_GATEWAY_INVALID_AND_UNAPPROVED_SESSION_DENIAL_PASS');

    const ownerSession = await request(gatewayPort, '/auth/session', {
      headers: authorization(ownerToken)
    });
    assert.equal(ownerSession.status, 200);
    assert.equal(ownerSession.json.user.role, 'owner');
    for (const capability of [
      'chat:use',
      'voice:use',
      'vision:read',
      'dreams:read',
      'neural:read',
      'system:read',
      'system:control',
      'runtime:control',
      'self_improvement:control',
      'candidate:review',
      'settings:write',
      'ws:connect'
    ]) {
      assert.equal(
        ownerSession.json.capabilities.includes(capability),
        true,
        `owner capability missing: ${capability}`
      );
    }

    const userSession = await request(gatewayPort, '/auth/session', {
      headers: authorization(userToken)
    });
    assert.equal(userSession.status, 200);
    assert.equal(userSession.json.capabilities.includes('chat:use'), true);
    assert.equal(
      userSession.json.capabilities.includes('self_improvement:control'),
      false
    );
    assert.equal(userSession.json.capabilities.includes('system:control'), false);
    marker('FLOKI_GATEWAY_OWNER_CAPABILITY_SUMMARY_PASS');

    for (const [method, pathname] of [
      ['GET', '/interface/status'],
      ['GET', '/self-improvement/status'],
      ['POST', '/control/modules/vision/restart'],
      ['GET', '/settings']
    ]) {
      const result = await request(gatewayPort, pathname, {
        method,
        headers: authorization(ownerToken),
        body: method === 'POST' ? {} : undefined
      });
      assert.equal(result.status, 200, `${method} ${pathname}`);
    }
    marker('FLOKI_GATEWAY_OWNER_PROTECTED_CATEGORIES_PASS');

    const backendCountBeforeDenials = records.length;
    const deniedRsi = await request(gatewayPort, '/self-improvement/status', {
      headers: authorization(userToken)
    });
    assert.equal(deniedRsi.status, 403);
    const deniedControl = await request(gatewayPort, '/control/modules/vision/restart', {
      method: 'POST',
      headers: authorization(userToken),
      body: {}
    });
    assert.equal(deniedControl.status, 403);
    assert.equal(records.length, backendCountBeforeDenials);
    marker('FLOKI_GATEWAY_NON_OWNER_CONTROL_DENIAL_PASS');

    const unknown = await request(gatewayPort, '/unknown-protected-route', {
      headers: authorization(ownerToken)
    });
    assert.equal(unknown.status, 403);
    const root = await request(gatewayPort, '/', {
      headers: authorization(ownerToken)
    });
    assert.equal(root.status, 403);
    assert.equal(
      records.some((entry) => entry.url === '/unknown-protected-route'),
      false
    );
    marker('FLOKI_GATEWAY_UNKNOWN_ROUTE_FAIL_CLOSED_PASS');

    const pause = await request(gatewayPort, '/self-improvement/pause', {
      method: 'POST',
      headers: authorization(ownerToken),
      body: {
        token: 'clifx7',
        reason: 'isolated-fixture-only'
      }
    });
    assert.equal(pause.status, 200);
    const pauseRecord = records.find(
      (entry) => entry.url === '/self-improvement/pause'
    );
    assert.ok(pauseRecord, 'fake runtime did not receive privileged route');
    assert.equal(pauseRecord.body.token, internalRsiToken);
    assert.equal(pauseRecord.headers.authorization, undefined);
    assert.equal(pause.text.includes(internalRsiToken), false);
    assert.equal(pause.text.includes('clifx7'), false);
    assert.equal(pause.json.token, '[REDACTED]');
    assert.equal(pause.json.nested.approval_token, '[REDACTED]');
    assert.equal(pause.json.nested.message.includes(internalRsiToken), false);
    marker('FLOKI_GATEWAY_RSI_INJECTION_AND_RESPONSE_SANITIZATION_PASS');

    const chat = await request(gatewayPort, '/chat/send', {
      method: 'POST',
      headers: authorization(ownerToken),
      body: {
        token: 'ordfx7',
        text: 'isolated fixture'
      }
    });
    assert.equal(chat.status, 200);
    const chatRecord = records.find((entry) => entry.url === '/chat/send');
    assert.ok(chatRecord, 'fake runtime did not receive chat route');
    assert.equal(chatRecord.body.token, 'ordfx7');
    assert.notEqual(chatRecord.body.token, internalRsiToken);
    assert.equal(chatRecord.headers.authorization, undefined);
    assert.equal(chat.headers.authorization, undefined);
    assert.equal(chat.headers['set-cookie'], undefined);
    marker('FLOKI_GATEWAY_RSI_INJECTION_SCOPE_PASS');

    const wsMissing = await websocketHandshake(gatewayPort, '/ws');
    assert.equal(wsMissing.status, 401);
    const wsInvalid = await websocketHandshake(gatewayPort, '/ws', {
      Authorization: 'Bearer invalid-token'
    });
    assert.equal(wsInvalid.status, 401);

    const wsOwner = await websocketHandshake(gatewayPort, '/ws', {
      Authorization: `Bearer ${ownerToken}`
    });
    assert.equal(wsOwner.status, 101);
    const ownerWsRecord = wsRecords.at(-1);
    assert.equal(ownerWsRecord.url, '/ws');
    assert.equal(ownerWsRecord.headers.authorization, undefined);

    const wsQuery = await websocketHandshake(
      gatewayPort,
      `/ws?token=${encodeURIComponent(ownerToken)}&channel=neural`
    );
    assert.equal(wsQuery.status, 101);
    const queryWsRecord = wsRecords.at(-1);
    assert.equal(queryWsRecord.url, '/ws?channel=neural');
    assert.equal(queryWsRecord.url.includes(ownerToken), false);

    const protectedWsUser = await websocketHandshake(
      gatewayPort,
      '/self-improvement/ws',
      { Authorization: `Bearer ${userToken}` }
    );
    assert.equal(protectedWsUser.status, 403);
    const protectedWsOwner = await websocketHandshake(
      gatewayPort,
      '/self-improvement/ws',
      { Authorization: `Bearer ${ownerToken}` }
    );
    assert.equal(protectedWsOwner.status, 101);
    marker('FLOKI_GATEWAY_WEBSOCKET_IDENTITY_AND_PERMISSION_PASS');

    await new Promise((resolve) => setTimeout(resolve, 100));
    const combinedOutput = output.join('');
    assert.equal(
      combinedOutput.includes(internalRsiToken),
      false,
      'internal RSI token leaked into gateway output'
    );
    assert.equal(
      combinedOutput.includes(ownerToken),
      false,
      'owner session token leaked into gateway output'
    );
    marker('FLOKI_GATEWAY_SECRET_NON_DISCLOSURE_PASS');

    const injectedCount = countRequests(
      records,
      (entry) => entry.body && entry.body.token === internalRsiToken
    );
    assert.equal(injectedCount, 1);
    marker('FLOKI_GATEWAY_AUTHORIZATION_E2E_PASS');
    succeeded = true;
  } finally {
    gateway.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref();
      gateway.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (!succeeded) {
    throw new Error('gateway E2E did not reach success marker');
  }
}

main().catch((error) => {
  console.error('FLOKI_GATEWAY_AUTHORIZATION_E2E_FAIL');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
