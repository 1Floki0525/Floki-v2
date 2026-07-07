'use strict';

/**
 * Sign internal lifecycle requests bound for the out-of-process supervisor.
 *
 * Never logs the private key. Uses Ed25519 over the canonical
 * method|module|action|timestamp|nonce|bodyHash message.
 *
 * Accepts the private key as:
 *   - PEM PKCS#8 string
 *   - raw 32-byte Ed25519 seed (Buffer or base64)
 *   - DER PKCS#8 (48 bytes, Buffer or base64)
 */

const crypto = require('node:crypto');

const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220400', 'hex');

function bodyHash(body) {
  const canonical = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function buildSignedMessage(method, module, action, timestamp, nonce, bodyHashValue) {
  const parts = [
    String(method || 'POST').toUpperCase(),
    String(module || ''),
    String(action || ''),
    String(timestamp || ''),
    String(nonce || ''),
    String(bodyHashValue || '')
  ];
  return parts.join('|');
}

function parseAuthHeader(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value.toLowerCase().startsWith('floki-ed25519 ')) return null;
  const rest = value.slice('floki-ed25519 '.length).trim();
  const parts = rest.split(';').map((part) => part.trim());
  const result = { raw: rest };
  for (const part of parts) {
    const equalIndex = part.indexOf('=');
    if (equalIndex < 0) continue;
    const key = part.slice(0, equalIndex).trim();
    let val = part.slice(equalIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function normalizeSignature(signature) {
  if (!signature) return null;
  try {
    return Buffer.from(String(signature).replace(/\s+/g, ''), 'base64');
  } catch (_error) {
    return null;
  }
}

function verifySignature(publicKey, message, signature) {
  if (!publicKey || publicKey.length !== 32) return false;
  const sig = normalizeSignature(signature);
  if (!sig || sig.length !== 64) return false;
  try {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const fullPublicKey = Buffer.concat([spkiPrefix, publicKey]);
    const keyObject = crypto.createPublicKey({ key: fullPublicKey, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, sig);
  } catch (_error) {
    return false;
  }
}

function keyObjectFromPrivateInput(privateKey) {
  if (!privateKey) {
    throw new TypeError('private key is required');
  }

  // PEM string.
  if (typeof privateKey === 'string' && privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    return crypto.createPrivateKey({ key: privateKey, format: 'pem', type: 'pkcs8' });
  }

  const keyBuffer = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(String(privateKey), 'base64');

  // Raw 32-byte seed.
  if (keyBuffer.length === 32) {
    const fullPrivateKey = Buffer.concat([PKCS8_SEED_PREFIX, keyBuffer]);
    return crypto.createPrivateKey({ key: fullPrivateKey, format: 'der', type: 'pkcs8' });
  }

  // DER PKCS#8 (48 bytes for Ed25519).
  if (keyBuffer.length === 48) {
    return crypto.createPrivateKey({ key: keyBuffer, format: 'der', type: 'pkcs8' });
  }

  throw new TypeError('private key must be a 32-byte Ed25519 seed, 48-byte DER PKCS#8, or PEM PKCS#8');
}

function buildAuthorizationHeader(privateKey, method, module, action, body = '') {
  const keyObject = keyObjectFromPrivateInput(privateKey);

  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('base64url');
  const hash = bodyHash(body);
  const message = buildSignedMessage(method, module, action, timestamp, nonce, hash);
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), keyObject);
  const signatureB64 = signature.toString('base64url');

  const header = 'floki-ed25519 ' + [
    'module="' + String(module || '') + '"',
    'action="' + String(action || '') + '"',
    'timestamp="' + timestamp + '"',
    'nonce="' + nonce + '"',
    'signature="' + signatureB64 + '"'
  ].join('; ');

  return Object.freeze({
    header,
    timestamp: Number(timestamp),
    nonce,
    body_hash: hash,
    module: String(module || ''),
    action: String(action || '')
  });
}

module.exports = {
  bodyHash,
  buildSignedMessage,
  buildAuthorizationHeader,
  parseAuthHeader,
  verifySignature
};
