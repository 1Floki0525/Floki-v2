'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

let proxyQueueTail = Promise.resolve();
let proxyQueueStats = { totalProcessed: 0, totalRejected: 0, totalCancelled: 0, lastErrors: [] };

function loadDefaultConfig() {
  return require('./config.cjs').loadSelfImprovementConfig();
}

function proxyPaths(config = null) {
  const resolved = config || loadDefaultConfig();
  return Object.freeze({
    root: resolved.model_proxy_root,
    socket: path.join(resolved.model_proxy_root, resolved.model_proxy_socket_name)
  });
}

function sendJson(response, statusCode, payload, connectionHeader) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: connectionHeader
  });
  response.end(body);
}

function collectRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;

    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        exceeded = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once('aborted', () => {
      reject(new Error('sandbox request was aborted before upload completed'));
    });
    request.once('error', reject);
    request.once('end', () => {
      if (exceeded) {
        reject(new Error(
          'sandbox request exceeded YAML-configured maximum bytes: ' +
          String(maximumBytes)
        ));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function upstreamHeaders(incomingHeaders, targetHost, bodyLength, connectionHeader) {
  const blocked = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]);
  const headers = {};
  for (const [name, value] of Object.entries(incomingHeaders || {})) {
    if (!blocked.has(String(name).toLowerCase())) headers[name] = value;
  }
  headers.host = targetHost;
  headers.connection = connectionHeader;
  if (bodyLength > 0) headers['content-length'] = String(bodyLength);
  return headers;
}

function requestOverSocket(socketPath, requestPath, timeoutMs, connectionHeader) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: 'GET',
      headers: { connection: connectionHeader }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('aborted', () => {
        reject(new Error('model proxy health response was aborted'));
      });
      response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(
            'model proxy health request failed with HTTP ' +
            response.statusCode + ': ' + body
          ));
          return;
        }
        resolve({ status: response.statusCode, body });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('model proxy health request timed out'));
    });
    request.once('error', reject);
    request.end();
  });
}

function createModelProxy(config = null) {
  const resolved = config || loadDefaultConfig();
  const target = new URL(resolved.model.endpoint);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(
      'self-improvement model proxy requires an HTTP or HTTPS model endpoint'
    );
  }
  const transport = target.protocol === 'https:' ? https : http;
  const p = proxyPaths(resolved);
  let server = null;

  async function forward(incoming, outgoing) {
    outgoing.once('error', () => {});

    let body;
    try {
      body = await collectRequestBody(
        incoming,
        resolved.model_request_max_bytes
      );
    } catch (error) {
      sendJson(
        outgoing,
        413,
        { ok: false, error: error.message },
        resolved.model_proxy_connection_header
      );
      return;
    }

    const incomingPath = new URL(
      incoming.url,
      'http://unix-socket'
    ).pathname;
    const allowed =
      (
        incoming.method === 'GET' &&
        incomingPath === resolved.model_proxy_health_path
      ) ||
      (
        incoming.method === 'POST' &&
        incomingPath === resolved.ollama_chat_path
      );

    if (!allowed) {
      sendJson(
        outgoing,
        403,
        { ok: false, error: 'model proxy request is not permitted' },
        resolved.model_proxy_connection_header
      );
      return;
    }

    // Simple FIFO serial queue: chain a tail promise so requests run in arrival order
    const previous = proxyQueueTail;
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    proxyQueueTail = next;

    let released = false;
    function releaseOnce() {
      if (released) return;
      released = true;
      release();
    }

    let timedOut = false;
    const queueTimeoutMs = Math.max(1000, Number(resolved.model_queue_timeout_ms) || 180000);
    const timer = setTimeout(() => {
      timedOut = true;
      proxyQueueStats.totalRejected += 1;
      sendJson(
        outgoing,
        504,
        { ok: false, error: 'model proxy queue deadline exceeded' },
        resolved.model_proxy_connection_header
      );
      releaseOnce();
    }, queueTimeoutMs);

    incoming.once('close', () => {
      if (timedOut || released) return;
      proxyQueueStats.totalCancelled += 1;
      clearTimeout(timer);
      sendJson(
        outgoing,
        499,
        { ok: false, error: 'model proxy request was cancelled before dispatch' },
        resolved.model_proxy_connection_header
      );
      releaseOnce();
    });

    try {
      await previous;
    } catch (_error) {
      // previous error should not affect this request
    }

    if (timedOut || released) {
      clearTimeout(timer);
      return;
    }
    clearTimeout(timer);

    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const upstream = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: incoming.method,
          path: incoming.url,
          headers: upstreamHeaders(
            incoming.headers,
            target.host,
            body.length,
            resolved.model_proxy_connection_header
          )
        }, (response) => {
          const headers = { ...response.headers };
          delete headers.connection;
          headers.connection = resolved.model_proxy_connection_header;

          if (!outgoing.headersSent && !outgoing.destroyed) {
            outgoing.writeHead(response.statusCode || 502, headers);
            response.pipe(outgoing);
          } else {
            response.resume();
          }

          response.once('end', finish);
          response.once('close', finish);
          response.once('error', (error) => {
            if (!outgoing.destroyed) outgoing.destroy(error);
            finish();
          });
        });

        upstream.setTimeout(
          resolved.model_proxy_request_timeout_ms,
          () => {
            upstream.destroy(
              new Error('model proxy upstream request timed out')
            );
          }
        );
        upstream.once('error', (error) => {
          if (!outgoing.headersSent) {
            sendJson(
              outgoing,
              502,
              { ok: false, error: error.message },
              resolved.model_proxy_connection_header
            );
          } else if (!outgoing.destroyed) {
            outgoing.destroy(error);
          }
          finish();
        });

        upstream.end(body);
      });
      proxyQueueStats.totalProcessed += 1;
    } catch (error) {
      proxyQueueStats.lastErrors.push({ at: new Date().toISOString(), message: error.message });
      if (proxyQueueStats.lastErrors.length > 20) {
        proxyQueueStats.lastErrors = proxyQueueStats.lastErrors.slice(-20);
      }
    } finally {
      releaseOnce();
    }
  }

  async function start() {
    if (server) return status();
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.rmSync(p.socket, { force: true });

    server = http.createServer((incoming, outgoing) => {
      forward(incoming, outgoing).catch((error) => {
        sendJson(
          outgoing,
          500,
          { ok: false, error: error.message },
          resolved.model_proxy_connection_header
        );
      });
    });
    server.requestTimeout = resolved.model_proxy_request_timeout_ms;
    server.headersTimeout = resolved.model_proxy_request_timeout_ms;
    server.once('clientError', (_error, socket) => {
      if (socket.writable) {
        socket.end(
          'HTTP/1.1 400 Bad Request\r\n' +
          'Connection: ' + resolved.model_proxy_connection_header +
          '\r\n\r\n'
        );
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('model proxy socket startup timed out'));
      }, resolved.model_proxy_start_timeout_ms);
      server.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.listen(p.socket, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    fs.chmodSync(p.socket, 0o600);
    await requestOverSocket(
      p.socket,
      resolved.model_proxy_health_path,
      resolved.model_proxy_start_timeout_ms,
      resolved.model_proxy_connection_header
    );
    return status();
  }

  async function stop() {
    if (!server) {
      fs.rmSync(p.socket, { force: true });
      return;
    }
    const active = server;
    server = null;
    await new Promise((resolve) => active.close(() => resolve()));
    fs.rmSync(p.socket, { force: true });
  }

  function status() {
    return Object.freeze({
      running: Boolean(server),
      socket_path: p.socket,
      target_origin: target.origin,
      queue: Object.freeze({
        depth: proxyQueueStats.totalProcessed,
        total_processed: proxyQueueStats.totalProcessed,
        total_rejected: proxyQueueStats.totalRejected,
        total_cancelled: proxyQueueStats.totalCancelled,
        last_errors: proxyQueueStats.lastErrors.slice()
      })
    });
  }

  return Object.freeze({ start, stop, status });
}

module.exports = {
  collectRequestBody,
  createModelProxy,
  proxyPaths,
  requestOverSocket,
  upstreamHeaders
};
