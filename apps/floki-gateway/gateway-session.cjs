'use strict';

const crypto = require('node:crypto');

const SPKI_ED25519_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

const ACTIVE_ACCOUNT_STATUSES = Object.freeze(['active', 'approved']);
const OWNER_ROLES = Object.freeze(['owner', 'admin', 'administrator']);

const PERMISSIONS = Object.freeze({
  chat: Object.freeze(['owner', 'admin', 'administrator', 'user', 'ai']),
  interface: Object.freeze(['owner', 'admin', 'administrator', 'user', 'ai']),
  'self-improvement': OWNER_ROLES,
  control: OWNER_ROLES,
  settings: Object.freeze(['owner', 'admin', 'administrator', 'user']),
  system: OWNER_ROLES,
  uploads: Object.freeze(['owner', 'admin', 'administrator', 'user', 'ai']),
  schedule: Object.freeze(['owner', 'admin', 'administrator', 'user']),
  memory: Object.freeze(['owner', 'admin', 'administrator', 'user', 'ai']),
  auth: Object.freeze(['owner', 'admin', 'administrator', 'user']),
  ws: Object.freeze(['owner', 'admin', 'administrator', 'user', 'ai'])
});

const CATEGORY_CAPABILITIES = Object.freeze({
  chat: Object.freeze(['chat:use', 'voice:use']),
  interface: Object.freeze([
    'vision:read',
    'dreams:read',
    'neural:read',
    'system:read',
    'logs:read'
  ]),
  'self-improvement': Object.freeze([
    'self_improvement:read',
    'self_improvement:control',
    'candidate:review'
  ]),
  control: Object.freeze(['system:control', 'runtime:control']),
  settings: Object.freeze(['settings:write']),
  system: Object.freeze(['system:read']),
  uploads: Object.freeze(['uploads:write']),
  schedule: Object.freeze(['schedule:write']),
  memory: Object.freeze(['memory:read']),
  auth: Object.freeze(['auth:read']),
  ws: Object.freeze(['ws:connect'])
});

const RSI_TOKEN_ROUTES = Object.freeze([
  '/self-improvement/approve',
  '/self-improvement/deny',
  '/self-improvement/pause',
  '/self-improvement/resume',
  '/self-improvement/run-now',
  '/self-improvement/abort',
  '/self-improvement/training-resource/enter',
  '/self-improvement/training-resource/exit'
]);

function normalizedClaim(value) {
  return String(value || '').trim().toLowerCase();
}

function publicKeyFromBase64(publicKeyBase64) {
  const raw = Buffer.from(String(publicKeyBase64 || ''), 'base64');
  if (raw.length !== 32) {
    throw new TypeError('Ed25519 public key must be 32 bytes');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  });
}

function verifyToken(token, publicKey, options = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'invalid token format' };
  }

  const [payloadB64, signatureB64] = parts;
  let payloadBytes;
  let payload;
  try {
    payloadBytes = Buffer.from(payloadB64, 'base64');
    payload = JSON.parse(payloadBytes.toString('utf-8'));
  } catch {
    return { ok: false, reason: 'invalid payload encoding' };
  }

  try {
    const signature = Buffer.from(signatureB64, 'base64');
    if (!crypto.verify(undefined, payloadBytes, publicKey, signature)) {
      return { ok: false, reason: 'signature verification failed' };
    }
  } catch {
    return { ok: false, reason: 'signature verification failed' };
  }

  const now = Number.isFinite(options.now)
    ? Number(options.now)
    : Math.floor(Date.now() / 1000);

  if (payload.iss !== options.issuer) {
    return { ok: false, reason: 'invalid issuer' };
  }
  if (payload.aud !== options.audience) {
    return { ok: false, reason: 'invalid audience' };
  }
  if (!Number.isFinite(payload.exp)) {
    return { ok: false, reason: 'missing expiry' };
  }
  if (payload.exp <= now) {
    return { ok: false, reason: 'token expired' };
  }
  if (payload.nbf !== undefined && !Number.isFinite(payload.nbf)) {
    return { ok: false, reason: 'invalid not-before claim' };
  }
  if (Number.isFinite(payload.nbf) && payload.nbf > now) {
    return { ok: false, reason: 'token not yet valid' };
  }
  if (!payload.sub) {
    return { ok: false, reason: 'missing subject' };
  }

  const role = normalizedClaim(payload.role);
  if (!role) {
    return { ok: false, reason: 'missing role' };
  }

  const status = normalizedClaim(payload.status);
  if (!status) {
    return { ok: false, reason: 'missing status' };
  }
  if (!ACTIVE_ACCOUNT_STATUSES.includes(status)) {
    return { ok: false, reason: 'account is not approved' };
  }

  return {
    ok: true,
    payload: {
      ...payload,
      role,
      status
    }
  };
}

function routeCategory(path) {
  const clean = String(path || '').split('?')[0];
  return clean.split('/').filter(Boolean)[0] || '';
}

function checkPermission(role, path) {
  const category = routeCategory(path);
  if (!category) return false;
  const allowed = PERMISSIONS[category];
  return Array.isArray(allowed) && allowed.includes(normalizedClaim(role));
}

function capabilitiesForRole(role) {
  const normalizedRole = normalizedClaim(role);
  const capabilities = new Set();
  for (const [category, roles] of Object.entries(PERMISSIONS)) {
    if (!roles.includes(normalizedRole)) continue;
    for (const capability of CATEGORY_CAPABILITIES[category] || []) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities).sort();
}

function sessionSummary(payload) {
  return {
    ok: true,
    user: {
      sub: String(payload.sub),
      role: normalizedClaim(payload.role),
      status: normalizedClaim(payload.status),
      expires_at: Number.isFinite(payload.exp) ? payload.exp : null
    },
    capabilities: capabilitiesForRole(payload.role)
  };
}

function extractUpgradeCredential(req) {
  const headers = req && req.headers ? req.headers : {};
  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return { token, source: 'authorization' };
  }

  try {
    const parsed = new URL(req.url, 'http://localhost');
    const token = parsed.searchParams.get('token');
    if (token) return { token, source: 'query' };
  } catch {
    // Fall through to the legacy subprotocol path.
  }

  const protocolHeader = headers['sec-websocket-protocol'];
  if (typeof protocolHeader === 'string' && protocolHeader.trim()) {
    const token = protocolHeader.split(',').map((entry) => entry.trim())[0] || '';
    if (token) return { token, source: 'protocol' };
  }

  return null;
}

function extractUpgradeToken(req) {
  const credential = extractUpgradeCredential(req);
  return credential ? credential.token : null;
}

module.exports = {
  ACTIVE_ACCOUNT_STATUSES,
  OWNER_ROLES,
  PERMISSIONS,
  CATEGORY_CAPABILITIES,
  RSI_TOKEN_ROUTES,
  publicKeyFromBase64,
  verifyToken,
  routeCategory,
  checkPermission,
  capabilitiesForRole,
  sessionSummary,
  extractUpgradeCredential,
  extractUpgradeToken
};
