'use strict';

/**
 * Omen gateway authorization utilities.
 *
 * Verifies a gateway-signed JWT and enforces issuer, audience, expiry,
 * not-before, account status, role, exact permission, module allowlist, and
 * action allowlist. Authorization denials return 401/403/404/400; normal
 * denials never produce 500.
 */

const crypto = require('node:crypto');

const REQUIRED_ALGORITHM = 'EdDSA';

function base64urlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(pad), 'base64');
}

function safeJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function splitToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  return { header: parts[0], payload: parts[1], signature: parts[2] };
}

function publicKeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new TypeError('public key JWK must be OKP Ed25519 with base64url x');
  }
  const x = base64urlDecode(jwk.x);
  if (x.length !== 32) {
    throw new TypeError('Ed25519 public key must be 32 bytes');
  }
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const fullPublicKey = Buffer.concat([spkiPrefix, x]);
  return crypto.createPublicKey({ key: fullPublicKey, format: 'der', type: 'spki' });
}

function verifyGatewayJwt(token, publicKeyJwk, options = {}) {
  const parts = splitToken(token);
  if (!parts) {
    return { ok: false, status: 401, error: 'malformed jwt' };
  }

  const headerBuffer = base64urlDecode(parts.header);
  const payloadBuffer = base64urlDecode(parts.payload);
  const header = safeJson(headerBuffer);
  const payload = safeJson(payloadBuffer);
  if (!header || !payload) {
    return { ok: false, status: 401, error: 'malformed jwt payload' };
  }

  if (header.alg !== REQUIRED_ALGORITHM) {
    return { ok: false, status: 401, error: 'unsupported jwt algorithm' };
  }
  if (header.typ !== 'JWT') {
    return { ok: false, status: 401, error: 'unsupported jwt type' };
  }

  let keyObject;
  try {
    keyObject = publicKeyFromJwk(publicKeyJwk);
  } catch (error) {
    return { ok: false, status: 401, error: 'invalid public key: ' + error.message };
  }

  const signedInput = parts.header + '.' + parts.payload;
  const signature = base64urlDecode(parts.signature);
  try {
    const valid = crypto.verify(null, Buffer.from(signedInput, 'utf8'), keyObject, signature);
    if (!valid) {
      return { ok: false, status: 401, error: 'invalid jwt signature' };
    }
  } catch (_error) {
    return { ok: false, status: 401, error: 'signature verification failed' };
  }

  const now = Math.floor(Date.now() / 1000);
  const iss = String(payload.iss || '');
  const expectedIssuer = options.issuer || 'omen-gateway';
  if (iss !== expectedIssuer) {
    return { ok: false, status: 401, error: 'invalid jwt issuer' };
  }

  const aud = payload.aud;
  const expectedAudience = options.audience || 'floki-control-plane';
  if (typeof aud === 'string') {
    if (aud !== expectedAudience) {
      return { ok: false, status: 401, error: 'invalid jwt audience' };
    }
  } else if (Array.isArray(aud)) {
    if (!aud.includes(expectedAudience)) {
      return { ok: false, status: 401, error: 'invalid jwt audience' };
    }
  } else {
    return { ok: false, status: 401, error: 'missing jwt audience' };
  }

  if (typeof payload.exp !== 'number' || now > payload.exp) {
    return { ok: false, status: 401, error: 'jwt expired' };
  }
  if (typeof payload.nbf !== 'number' || now < payload.nbf) {
    return { ok: false, status: 401, error: 'jwt not yet valid' };
  }

  const account = payload.account || {};
  if (account.status !== 'active') {
    return { ok: false, status: 403, error: 'account not active' };
  }

  const role = String(payload.role || '');
  const allowedRoles = Array.isArray(options.allowed_roles) ? options.allowed_roles : ['supervisor'];
  if (!allowedRoles.includes(role)) {
    return { ok: false, status: 403, error: 'unauthorized role' };
  }

  const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];
  const expectedPermission = options.permission || ('modules:' + String(payload.action || options.action || ''));
  if (!permissions.includes(expectedPermission)) {
    return { ok: false, status: 403, error: 'missing required permission: ' + expectedPermission };
  }

  const moduleKey = String(payload.module || options.module || '');
  const action = String(payload.action || options.action || '');
  if (!moduleKey) {
    return { ok: false, status: 400, error: 'missing module' };
  }
  if (!action) {
    return { ok: false, status: 400, error: 'missing action' };
  }

  const allowedModules = Array.isArray(options.allowed_modules) ? options.allowed_modules : [];
  if (!allowedModules.includes(moduleKey)) {
    return { ok: false, status: 404, error: 'unknown module' };
  }

  const allowedActions = Array.isArray(options.allowed_actions) ? options.allowed_actions : ['start', 'stop', 'reset'];
  if (!allowedActions.includes(action)) {
    return { ok: false, status: 400, error: 'unknown action' };
  }

  return {
    ok: true,
    status: 200,
    claims: Object.freeze({
      iss,
      aud,
      sub: payload.sub || null,
      exp: payload.exp,
      nbf: payload.nbf,
      account_status: account.status,
      role,
      permissions,
      module: moduleKey,
      action
    })
  };
}

function authorizeControlRequest(token, publicKeyJwk, moduleKey, action, options = {}) {
  const requestedModule = String(moduleKey || '');
  const requestedAction = String(action || '');
  const allowedModules = Array.isArray(options.allowed_modules)
    ? options.allowed_modules
    : [];
  if (!requestedModule || !allowedModules.includes(requestedModule)) {
    return { ok: false, status: 404, error: 'unknown module' };
  }
  const allowedActions = Array.isArray(options.allowed_actions)
    ? options.allowed_actions
    : ['start', 'stop', 'reset'];
  if (!requestedAction || !allowedActions.includes(requestedAction)) {
    return { ok: false, status: 400, error: 'unknown action' };
  }

  const verified = verifyGatewayJwt(token, publicKeyJwk, {
    issuer: options.issuer,
    audience: options.audience,
    allowed_roles: options.allowed_roles,
    allowed_modules: allowedModules,
    allowed_actions: allowedActions,
    permission: 'modules:' + requestedAction,
    module: requestedModule,
    action: requestedAction
  });
  if (!verified.ok) return verified;

  if (
    verified.claims.module !== requestedModule ||
    verified.claims.action !== requestedAction
  ) {
    return {
      ok: false,
      status: 403,
      error: 'token is not bound to the requested module and action'
    };
  }

  return verified;
}

module.exports = {
  verifyGatewayJwt,
  authorizeControlRequest,
  publicKeyFromJwk,
  splitToken
};
