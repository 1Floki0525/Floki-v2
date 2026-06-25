'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  createModelProxy
} = require('../src/self-improvement/model-proxy.cjs');

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function postOverSocket(socketPath, requestPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        connection: 'close'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('aborted', () => {
        reject(new Error('proxy response aborted'));
      });
      response.once('error', reject);
      response.once('end', () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('proxy test request timed out'));
    });
    request.once('error', reject);
    request.end(body);
  });
}

(async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-rsi-proxy-')
  );
  let receivedBytes = 0;

  const upstream = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      const body = JSON.stringify({ models: [] });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      receivedBytes = Buffer.concat(chunks).length;
      const body = JSON.stringify({
        message: {
          role: 'assistant',
          content: 'transport-ok'
        }
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });
      response.end(body);
    });
  });

  await listen(upstream, { host: '127.0.0.1', port: 0 });
  const address = upstream.address();

  const config = {
    model: {
      endpoint: `http://127.0.0.1:${address.port}`
    },
    model_proxy_root: tempRoot,
    model_proxy_socket_name: 'ollama.sock',
    model_proxy_health_path: '/api/tags',
    ollama_chat_path: '/api/chat',
    model_proxy_start_timeout_ms: 5000,
    model_proxy_request_timeout_ms: 10000,
    model_proxy_connection_header: 'close',
    model_request_max_bytes: 8 * 1024 * 1024
  };

  const proxy = createModelProxy(config);
  try {
    await proxy.start();

    const payload = Buffer.from(JSON.stringify({
      model: 'transport-test',
      messages: [{
        role: 'user',
        content: 'x'.repeat(2 * 1024 * 1024)
      }],
      stream: false
    }));

    const result = await postOverSocket(
      path.join(tempRoot, 'ollama.sock'),
      '/api/chat',
      payload,
      10000
    );

    assert.equal(result.status, 200);
    assert.equal(receivedBytes, payload.length);
    assert.equal(
      JSON.parse(result.body).message.content,
      'transport-ok'
    );
  } finally {
    await proxy.stop();
    await close(upstream);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_MODEL_PROXY_EPIPE_CONTRACT_PASS'
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
