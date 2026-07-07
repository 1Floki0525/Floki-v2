'use strict';

/**
 * Omen gateway control-plane client.
 *
 * Signs a control request with the configured Ed25519 private key and sends it
 * to the Omen gateway HTTPS endpoint. The gateway is responsible for JWT
 * verification, account/role/permission/module/action allowlist checks, and
 * proxying the signed request to the workstation reverse listener at
 * 127.0.0.1:17701.
 *
 * The client never embeds WordPress credentials or static secrets. It reads
 * the private signing key from config or environment.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { buildAuthorizationHeader } = require('./sign-request.cjs');
const { getControlPlaneConfig } = require('../config/floki-config.cjs');

function readPrivateKey(source) {
  if (!source) {
    throw new Error('gateway signing key source not configured');
  }
  const expanded = String(source).replace(/^~(?=\/)/, process.env.HOME || '');
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error('gateway signing key not found: ' + resolved);
  }
  return fs.readFileSync(resolved, 'utf8').trim();
}

function resolveKeySource() {
  const envKey = process.env.FLOKI_GATEWAY_PRIVATE_KEY_PATH;
  if (envKey) return envKey;
  try {
    const config = getControlPlaneConfig('chat');
    return config.supervisor_private_key_path || null;
  } catch (_error) {
    return null;
  }
}

function gatewayRequestTimeoutMs() {
  try {
    const config = getControlPlaneConfig('chat');
    return Math.max(1000, Number(config.supervisor_operation_timeout_ms || 360000));
  } catch (_error) {
    return 360000;
  }
}

function requestProtocol(gatewayHost) {
  const host = String(gatewayHost || '');
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') ? http : https;
}

function buildRequestUrl(gatewayHost, gatewayPort, moduleKey, action) {
  const host = String(gatewayHost || '127.0.0.1');
  const port = Number(gatewayPort || 443);
  const isLocalhost = host === '127.0.0.1' || host === 'localhost';
  const scheme = isLocalhost ? 'http' : 'https';
  const base = host.includes('://') ? host : (scheme + '://' + host + ':' + port);
  const cleanBase = base.replace(/\/$/, '');
  return cleanBase + '/modules/' + encodeURIComponent(moduleKey) + '/' + encodeURIComponent(action);
}

function forwardControlRequestToSupervisor(moduleKey, action, body, gatewayHost, gatewayPort) {
  return new Promise((resolve) => {
    let settled = false;
    const keySource = resolveKeySource();
    let privateKey;
    try {
      privateKey = readPrivateKey(keySource);
    } catch (error) {
      resolve({ ok: false, status: 0, error: 'gateway signing key unavailable: ' + error.message });
      return;
    }

    const requestBody = JSON.stringify(body || {});
    const signed = buildAuthorizationHeader(privateKey, 'POST', moduleKey, action, requestBody);
    const url = new URL(buildRequestUrl(gatewayHost, gatewayPort, moduleKey, action));
    const isHttp = url.protocol === 'http:';
    const protocol = isHttp ? http : https;

    const options = {
      host: url.hostname,
      port: Number(url.port || (isHttp ? 80 : 443)),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody),
        authorization: signed.header
      },
      timeout: gatewayRequestTimeoutMs()
    };

    const req = protocol.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch (_error) {
          json = null;
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          data: json,
          raw,
          error: json && json.error ? json.error : null
        });
      });
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 0, error: error.message });
    });

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ok: false, status: 0, error: 'gateway request timed out' });
    });

    req.write(requestBody);
    req.end();
  });
}

module.exports = {
  forwardControlRequestToSupervisor,
  buildRequestUrl,
  readPrivateKey,
  resolveKeySource
};
