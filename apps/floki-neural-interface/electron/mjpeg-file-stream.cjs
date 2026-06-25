'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function completeJpeg(data) {
  return Buffer.isBuffer(data) &&
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[data.length - 2] === 0xff &&
    data[data.length - 1] === 0xd9;
}

function createMjpegFileStreamServer(options = {}) {
  const frameValue = String(options.frame_file || '').trim();
  if (!frameValue) throw new Error('frame_file is required');
  const frameFile = path.resolve(frameValue);
  const freshnessMs = Math.max(100, Number(options.freshness_ms || 1000));
  const watchIntervalMs = Math.max(25, Number(options.watch_interval_ms || 50));
  const boundary = String(options.boundary || 'flokiliveboundary');
  const host = String(options.host || '127.0.0.1');
  const fsImpl = options.fs || fs;
  const httpImpl = options.http || http;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const onError = typeof options.on_error === 'function' ? options.on_error : () => {};
  const clients = new Set();
  let server = null;
  let port = 0;
  let startPromise = null;

  function closeClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    try { fsImpl.unwatchFile(frameFile, client.listener); } catch (error) { onError(error); }
    clients.delete(client);
    if (!client.response.destroyed && !client.response.writableEnded) client.response.end();
  }

  function sendFrame(client, current) {
    if (!client || client.closed || client.response.destroyed || client.response.writableEnded) return false;
    try {
      const mtimeMs = Number(current && current.mtimeMs || 0);
      const ageMs = Math.max(0, Number(now()) - mtimeMs);
      if (!mtimeMs || ageMs > freshnessMs || Number(current.size || 0) <= 0 || mtimeMs === client.lastMtimeMs) return false;
      const data = fsImpl.readFileSync(frameFile);
      if (!completeJpeg(data)) return false;
      client.lastMtimeMs = mtimeMs;
      client.response.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`);
      client.response.write(data);
      client.response.write('\r\n');
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      onError(error);
      closeClient(client);
      return false;
    }
  }

  function handleRequest(request, response) {
    if (request.url !== '/live.mjpeg') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const client = { response, closed: false, lastMtimeMs: 0, listener: null };
    client.listener = (current) => { sendFrame(client, current); };
    response.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
      connection: 'close'
    });
    clients.add(client);
    const close = () => closeClient(client);
    request.once('aborted', close);
    request.once('error', (error) => { onError(error); close(); });
    request.once('close', close);
    response.once('close', close);
    response.once('error', (error) => { onError(error); close(); });
    fsImpl.watchFile(frameFile, { interval: watchIntervalMs }, client.listener);
    try { client.listener(fsImpl.statSync(frameFile)); }
    catch (error) { if (!error || error.code !== 'ENOENT') { onError(error); close(); } }
  }

  function start() {
    if (server && port > 0) return Promise.resolve(port);
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      server = httpImpl.createServer(handleRequest);
      const fail = (error) => {
        server = null;
        port = 0;
        startPromise = null;
        reject(error);
      };
      server.once('error', fail);
      server.listen(0, host, () => {
        server.removeListener('error', fail);
        port = Number(server.address().port);
        startPromise = null;
        resolve(port);
      });
    });
    return startPromise;
  }

  function close() {
    for (const client of Array.from(clients)) closeClient(client);
    if (server) server.close();
    server = null;
    port = 0;
    startPromise = null;
  }

  return Object.freeze({
    frame_file: frameFile,
    freshness_ms: freshnessMs,
    watch_interval_ms: watchIntervalMs,
    boundary,
    start,
    close,
    get port() { return port; },
    get client_count() { return clients.size; }
  });
}

module.exports = { completeJpeg, createMjpegFileStreamServer };
