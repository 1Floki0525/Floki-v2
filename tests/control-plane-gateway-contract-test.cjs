'use strict';

/**
 * Omen gateway control-plane contract test.
 *
 * Verifies:
 *   - signed requests from the gateway client match the supervisor's expected
 *     floki-ed25519 authorization format;
 *   - JWT verification accepts valid tokens and rejects expired, future-NBF,
 *     invalid-signature, wrong-audience, and wrong-issuer tokens;
 *   - unknown modules return safe 404/400 without 500;
 *   - unauthorized roles return 403.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const { buildAuthorizationHeader } = require('../src/control-plane/sign-request.cjs');
const { verifyGatewayJwt, authorizeControlRequest } = require('../src/control-plane/gateway-auth.cjs');
const { forwardControlRequestToSupervisor } = require('../src/control-plane/gateway-client.cjs');
const { newId } = require('../src/util/ids.cjs');

const ISSUER = 'omen-gateway';
const AUDIENCE = 'floki-control-plane';
const ALLOWED_MODULES = Object.freeze(['floki_core', 'vision', 'rsi']);
const ALLOWED_ACTIONS = Object.freeze(['start', 'stop', 'reset']);
const ALLOWED_ROLES = Object.freeze(['supervisor', 'operator']);

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const jwk = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'jwk' });
  return {
    privateKey: crypto.createPrivateKey(privateKey),
    publicKey: jwk
  };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signJwt(privateKey, payload, header = { alg: 'EdDSA', typ: 'JWT' }) {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signedInput = headerB64 + '.' + payloadB64;
  const signature = crypto.sign(null, Buffer.from(signedInput, 'utf8'), privateKey).toString('base64url');
  return signedInput + '.' + signature;
}

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
  const testRoot = path.resolve(__dirname, '..', 'state', 'floki', 'test-gateway', newId('test'));
  fs.mkdirSync(testRoot, { recursive: true });

  const { privateKey: gatewayPrivateKey, publicKey: gatewayPublicKey } = generateKeypair();
  const { privateKey: supervisorPrivateKey, publicKey: supervisorPublicKey } = generateKeypair();

  const now = Math.floor(Date.now() / 1000);
  const validPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'account-123',
    iat: now,
    exp: now + 60,
    nbf: now,
    account: { status: 'active' },
    role: 'supervisor',
    permissions: ['modules:start'],
    module: 'floki_core',
    action: 'start'
  };
  const validToken = signJwt(gatewayPrivateKey, validPayload);

  const supervisorPort = await findFreePort();
  const gatewayPort = await findFreePort();

  const receivedRequests = [];
  const supervisorServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const match = url.pathname.match(/^\/modules\/([a-z_][a-z0-9_]*)\/(start|stop|reset)$/);
    if (!match) {
      const body = JSON.stringify({ ok: false, error: 'not found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      receivedRequests.push({
        module: match[1],
        action: match[2],
        auth: String(req.headers.authorization || ''),
        body: bodyBuffer.toString('utf8')
      });
      const out = JSON.stringify({ ok: true, module: match[1], action: match[2], source: 'supervisor' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
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

  const gatewayServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const match = url.pathname.match(/^\/control\/modules\/([a-z_][a-z0-9_]*)\/(start|stop|reset)$/);
    if (!match || req.method !== 'POST') {
      const body = JSON.stringify({ ok: false, error: 'not found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const moduleKey = match[1];
    const action = match[2];
    const auth = String(req.headers.authorization || '');
    const tokenMatch = auth.match(/^bearer\s+(.+)$/i);
    const token = tokenMatch ? tokenMatch[1] : '';

    const result = authorizeControlRequest(token, gatewayPublicKey, moduleKey, action, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS
    });

    if (!result.ok) {
      const body = JSON.stringify({ ok: false, error: result.error });
      res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const requestBody = Buffer.concat(chunks).toString('utf8');
      const signed = buildAuthorizationHeader(
        supervisorPrivateKey.export({ type: 'pkcs8', format: 'pem' }),
        'POST', moduleKey, action, requestBody
      );
      const proxy = await httpRequest(supervisorPort, '/modules/' + moduleKey + '/' + action, {
        method: 'POST',
        body: requestBody,
        headers: { authorization: signed.header }
      });
      res.writeHead(proxy.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(proxy.raw) });
      res.end(proxy.raw);
    });
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once('error', reject);
    gatewayServer.listen(gatewayPort, '127.0.0.1', () => {
      gatewayServer.removeListener('error', reject);
      resolve();
    });
  });

  try {
    // 1. Signed request from gateway client matches supervisor expected auth format.
    const privateKeyPath = path.join(testRoot, 'supervisor.key');
    fs.writeFileSync(privateKeyPath, supervisorPrivateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.FLOKI_GATEWAY_PRIVATE_KEY_PATH = privateKeyPath;

    const clientResult = await forwardControlRequestToSupervisor('floki_core', 'start', { reason: 'test' }, '127.0.0.1', supervisorPort);
    assert.equal(clientResult.ok, true);
    assert.equal(clientResult.status, 200);
    assert.equal(clientResult.data.module, 'floki_core');
    assert.equal(clientResult.data.action, 'start');
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].module, 'floki_core');
    assert.equal(receivedRequests[0].action, 'start');
    assert.ok(receivedRequests[0].auth.startsWith('floki-ed25519 '));
    assert.ok(receivedRequests[0].auth.includes('module="floki_core"'));
    assert.ok(receivedRequests[0].auth.includes('action="start"'));

    // 2. JWT verification accepts valid tokens.
    const valid = verifyGatewayJwt(validToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.status, 200);
    assert.equal(valid.claims.module, 'floki_core');
    assert.equal(valid.claims.action, 'start');

    // 3. Expired token is rejected with 401.
    const expiredPayload = { ...validPayload, iat: now - 120, exp: now - 60, nbf: now - 120 };
    const expiredToken = signJwt(gatewayPrivateKey, expiredPayload);
    const expired = verifyGatewayJwt(expiredToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.status, 401);

    // 4. Future not-before is rejected with 401.
    const futurePayload = { ...validPayload, iat: now, exp: now + 120, nbf: now + 120 };
    const futureToken = signJwt(gatewayPrivateKey, futurePayload);
    const future = verifyGatewayJwt(futureToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(future.ok, false);
    assert.equal(future.status, 401);

    // 5. Invalid signature is rejected with 401.
    const tamperedToken = validToken.slice(0, -8) + 'deadbeef';
    const tampered = verifyGatewayJwt(tamperedToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.status, 401);

    // 6. Wrong audience is rejected with 401.
    const wrongAudiencePayload = { ...validPayload, aud: 'other-service' };
    const wrongAudienceToken = signJwt(gatewayPrivateKey, wrongAudiencePayload);
    const wrongAudience = verifyGatewayJwt(wrongAudienceToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(wrongAudience.ok, false);
    assert.equal(wrongAudience.status, 401);

    // 7. Wrong issuer is rejected with 401.
    const wrongIssuerPayload = { ...validPayload, iss: 'evil-gateway' };
    const wrongIssuerToken = signJwt(gatewayPrivateKey, wrongIssuerPayload);
    const wrongIssuer = verifyGatewayJwt(wrongIssuerToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(wrongIssuer.ok, false);
    assert.equal(wrongIssuer.status, 401);

    // 8. Unknown module returns safe 404.
    const unknownPayload = { ...validPayload, module: 'unknown_module' };
    const unknownToken = signJwt(gatewayPrivateKey, unknownPayload);
    const unknown = verifyGatewayJwt(unknownToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(unknown.ok, false);
    assert.ok(unknown.status === 404 || unknown.status === 400, 'unknown module should be 404/400, got ' + unknown.status);

    // 9. Unauthorized role returns 403.
    const wrongRolePayload = { ...validPayload, role: 'guest' };
    const wrongRoleToken = signJwt(gatewayPrivateKey, wrongRolePayload);
    const wrongRole = verifyGatewayJwt(wrongRoleToken, gatewayPublicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      allowed_roles: ALLOWED_ROLES,
      allowed_modules: ALLOWED_MODULES,
      allowed_actions: ALLOWED_ACTIONS,
      permission: 'modules:start'
    });
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.status, 403);

    // 10. Full gateway endpoint rejects unknown module with 404/400.
    const unknownEndpoint = await httpRequest(gatewayPort, '/control/modules/unknown_module/start', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { authorization: 'Bearer ' + validToken }
    });
    assert.ok(unknownEndpoint.status === 404 || unknownEndpoint.status === 400, 'endpoint unknown module should be 404/400, got ' + unknownEndpoint.status);

    // 11. A token bound to one module cannot drive another module's route.
    const crossModule = await httpRequest(gatewayPort, '/control/modules/vision/start', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { authorization: 'Bearer ' + validToken }
    });
    assert.equal(crossModule.status, 403);

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_CONTROL_PLANE_GATEWAY_CONTRACT_PASS',
      tests: [
        'gateway_client_matches_supervisor_auth_format',
        'valid_jwt_accepted',
        'expired_jwt_rejected_401',
        'future_nbf_rejected_401',
        'invalid_signature_rejected_401',
        'wrong_audience_rejected_401',
        'wrong_issuer_rejected_401',
        'unknown_module_safe_404',
        'unauthorized_role_403',
        'endpoint_unknown_module_safe_status',
        'cross_module_token_rejected_403'
      ]
    }, null, 2));
  } finally {
    supervisorServer.close();
    gatewayServer.close();
    delete process.env.FLOKI_GATEWAY_PRIVATE_KEY_PATH;
  }
}

(async () => {
  try {
    await run();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CONTROL_PLANE_GATEWAY_CONTRACT_FAIL',
      error: error.message,
      stack: error.stack
    }, null, 2));
    process.exit(1);
  }
})();
