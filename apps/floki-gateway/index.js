// Floki public API gateway.
// Runs on the Omen host behind the Cloudflare tunnel for
// api.galactic-family-hub.com. The gateway validates approved-account
// sessions, applies route capabilities, injects the Omen-held internal RSI
// approval token only on authorized privileged routes, strips client
// credentials before proxying, and sanitizes privileged responses.
import { createServer } from 'http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { readFileSync, existsSync } from 'fs';
import { Buffer } from 'buffer';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const session = require(resolve(__dirname, 'gateway-session.cjs'));

const configDir = process.env.FLOKI_GATEWAY_CONFIG_DIR || __dirname;
const configPath = resolve(configDir, 'config.json');
const rsiTokenPath = resolve(configDir, '.rsi-token');

const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
cfg.rsiToken = existsSync(rsiTokenPath)
  ? readFileSync(rsiTokenPath, 'utf-8').trim()
  : '';

if (!cfg.publicKey || !cfg.issuer || !cfg.audience) {
  throw new Error('gateway config is missing publicKey, issuer, or audience');
}
if (!cfg.rsiToken) {
  throw new Error('gateway internal RSI token is missing or empty');
}

const app = express();
const PORT = Number(process.env.FLOKI_GATEWAY_PORT || 17710);
const HOST = '127.0.0.1';
const TARGET = cfg.proxyTarget || 'http://127.0.0.1:17702';
const MAX_PRIVILEGED_REQUEST_BYTES = 1024 * 1024;
const MAX_PRIVILEGED_RESPONSE_BYTES = 8 * 1024 * 1024;

const rlStore = new Map();
const rlSweep = setInterval(() => {
  const currentWindow = Math.floor(Date.now() / 60000);
  for (const [key] of rlStore) {
    if (Number.parseInt(key.split(':').pop(), 10) < currentWindow) {
      rlStore.delete(key);
    }
  }
}, 30000);
rlSweep.unref();

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://galactic-family-hub.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function rateLimit(limit) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const windowNumber = Math.floor(Date.now() / 60000);
    const key = `${ip}:${req.path}:${windowNumber}`;
    const count = (rlStore.get(key) || 0) + 1;
    rlStore.set(key, count);
    if (count > limit) {
      return res.status(429).json({ error: 'rate limit exceeded' });
    }
    next();
  };
}

const rlLimits = Object.freeze({
  auth: 30,
  chat: 30,
  control: 60,
  settings: 60,
  rsi: 120
});

function rateLimitFor(path) {
  const category = session.routeCategory(path);
  return rlLimits[category === 'self-improvement' ? 'rsi' : category] ?? null;
}

function removeSensitiveProxyHeaders(proxyReq) {
  for (const name of [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie'
  ]) {
    proxyReq.removeHeader(name);
  }
}

const BLOCKED_PROXY_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'authorization',
  'proxy-authorization',
  'set-cookie',
  'content-length',
  'transfer-encoding',
  'content-encoding'
]);

function removeSensitiveResponseHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (BLOCKED_PROXY_RESPONSE_HEADERS.has(name.toLowerCase())) {
      delete headers[name];
      continue;
    }
    if (value !== undefined) {
      safe[name] = value;
    }
  }
  return safe;
}

function sanitizeSecretValue(value, secret) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSecretValue(entry, secret));
  }
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(?:token|secret|authorization|cookie|password|credential)/i.test(key)) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = sanitizeSecretValue(entry, secret);
      }
    }
    return clean;
  }
  if (typeof value === 'string' && secret && value.includes(secret)) {
    return value.split(secret).join('[REDACTED]');
  }
  return value;
}

function sanitizePrivilegedResponse(buffer, contentType, secret) {
  const raw = buffer.toString('utf-8');
  if (/application\/json/i.test(String(contentType || ''))) {
    try {
      const parsed = JSON.parse(raw);
      return Buffer.from(
        JSON.stringify(sanitizeSecretValue(parsed, secret)),
        'utf-8'
      );
    } catch {
      // Fall through to raw string replacement.
    }
  }
  return Buffer.from(
    secret ? raw.split(secret).join('[REDACTED]') : raw,
    'utf-8'
  );
}

function sanitizedRequestPath(req) {
  return req.path || '/';
}

function sanitizeUpgradeRequest(req, credentialSource) {
  delete req.headers.authorization;
  delete req.headers['proxy-authorization'];
  delete req.headers.cookie;

  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
    for (const key of ['token', 'access_token', 'authorization']) {
      parsed.searchParams.delete(key);
    }
    const query = parsed.searchParams.toString();
    req.url = parsed.pathname + (query ? `?${query}` : '');
  } catch {
    req.url = String(req.url || '').split('?')[0] || '/ws';
  }

  if (credentialSource === 'protocol') {
    delete req.headers['sec-websocket-protocol'];
  }
}

app.use((req, res, next) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

const publicKey = session.publicKeyFromBase64(cfg.publicKey);
const verifyOptions = {
  issuer: cfg.issuer,
  audience: cfg.audience
};

// IMPORTANT: this middleware is mounted without a regex path. Express 5 strips
// a matched mount path before the handler inspects req.path. A plain app.use()
// keeps the complete original path for route-category authorization.
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'invalid token',
      reason: 'missing authorization header'
    });
  }

  const verification = session.verifyToken(
    authorization.slice(7),
    publicKey,
    verifyOptions
  );
  if (!verification.ok) {
    return res.status(401).json({
      error: 'invalid token',
      reason: verification.reason
    });
  }

  if (!session.checkPermission(verification.payload.role, req.path)) {
    return res.status(403).json({
      error: 'forbidden',
      reason: 'insufficient permissions'
    });
  }

  req.user = verification.payload;
  next();
});

app.use((req, res, next) => {
  const startedAt = Date.now();
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      method: req.method,
      path: sanitizedRequestPath(req),
      user: req.user?.sub || '-',
      status: res.statusCode,
      duration: Date.now() - startedAt
    }));
    originalEnd(...args);
  };
  next();
});

app.use((req, res, next) => {
  const limit = rateLimitFor(req.path);
  if (limit !== null) return rateLimit(limit)(req, res, next);
  next();
});

app.get('/auth/session', (req, res) => {
  res.json(session.sessionSummary(req.user));
});

app.use((req, res, next) => {
  const privilegedRoute =
    req.method === 'POST' &&
    session.RSI_TOKEN_ROUTES.includes(req.path);

  if (!privilegedRoute) return next();

  let body = '';
  let tooLarge = false;

  req.setEncoding('utf-8');
  req.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (Buffer.byteLength(body, 'utf-8') > MAX_PRIVILEGED_REQUEST_BYTES) {
      tooLarge = true;
      res.status(413).json({ error: 'payload too large' });
    }
  });
  req.on('end', () => {
    if (tooLarge || res.headersSent) return;

    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return res.status(400).json({ error: 'invalid request body' });
    }

    const candidateId = parsed.candidateId || parsed.id || null;
    delete parsed.token;
    parsed.token = cfg.rsiToken;
    req._flokiPrivilegedBody = JSON.stringify(parsed);

    console.log(JSON.stringify({
      type: 'audit',
      time: new Date().toISOString(),
      user: req.user?.sub || 'unknown',
      action: req.path.split('/').pop(),
      candidateId,
      timestamp: Date.now()
    }));
    next();
  });
  req.on('error', next);
});

function applyProxyResponseHeaders(proxyRes, res) {
  const safeHeaders = removeSensitiveResponseHeaders(proxyRes.headers);
  for (const [name, value] of Object.entries(safeHeaders)) {
    res.setHeader(name, value);
  }
  setCorsHeaders(res);
}

const privilegedProxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  proxyTimeout: 120000,
  timeout: 120000,
  selfHandleResponse: true,
  on: {
    proxyReq: (proxyReq, req) => {
      removeSensitiveProxyHeaders(proxyReq);
      proxyReq.setHeader('Accept-Encoding', 'identity');
      const body = req._flokiPrivilegedBody || '{}';
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
      proxyReq.write(body);
    },
    proxyRes: (proxyRes, req, res) => {
      const chunks = [];
      let size = 0;
      let finished = false;

      const fail = () => {
        if (finished) return;
        finished = true;
        if (!res.headersSent) {
          setCorsHeaders(res);
          res.status(502).json({ error: 'invalid upstream response' });
        } else {
          res.end();
        }
      };

      proxyRes.on('data', (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_PRIVILEGED_RESPONSE_BYTES) {
          proxyRes.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on('error', fail);
      proxyRes.on('end', () => {
        if (finished) return;
        finished = true;
        const body = sanitizePrivilegedResponse(
          Buffer.concat(chunks),
          proxyRes.headers['content-type'],
          cfg.rsiToken
        );
        res.statusCode = proxyRes.statusCode || 502;
        if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
        applyProxyResponseHeaders(proxyRes, res);
        res.setHeader('Content-Length', body.length);
        res.end(body);
      });
    },
    error: (error, req, res) => {
      if (!res.headersSent) {
        setCorsHeaders(res);
        res.status(502).json({ error: 'upstream unavailable' });
      }
    }
  }
});

const standardProxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  proxyTimeout: 120000,
  timeout: 120000,
  on: {
    proxyReq: (proxyReq) => {
      removeSensitiveProxyHeaders(proxyReq);
    },
    proxyRes: (proxyRes, req, res) => {
      applyProxyResponseHeaders(proxyRes, res);
    },
    error: (error, req, res) => {
      if (!res.headersSent) {
        setCorsHeaders(res);
        res.status(502).json({ error: 'upstream unavailable' });
      }
    }
  }
});

app.use((req, res, next) => {
  if (typeof req._flokiPrivilegedBody === 'string') {
    return privilegedProxy(req, res, next);
  }
  return standardProxy(req, res, next);
});

app.use((error, req, res, next) => {
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    error: 'unhandled',
    path: sanitizedRequestPath(req)
  }));
  if (!res.headersSent) {
    setCorsHeaders(res);
    res.status(500).json({ error: 'internal server error' });
  }
});

const server = createServer(app);

const wsProxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  ws: true
});

server.on('upgrade', (req, socket, head) => {
  const credential = session.extractUpgradeCredential(req);
  if (!credential) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const verification = session.verifyToken(
    credential.token,
    publicKey,
    verifyOptions
  );
  if (!verification.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!session.checkPermission(verification.payload.role, req.url)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  sanitizeUpgradeRequest(req, credential.source);
  wsProxy.upgrade(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    event: 'startup',
    time: new Date().toISOString(),
    port: PORT,
    host: HOST,
    target: TARGET
  }));
});
