'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const runtime = text('src/runtime/chat-local-runtime.cjs');
const routeStart = runtime.indexOf("url.pathname === '/interface/vision/frame/latest.jpg'");
assert.notEqual(routeStart, -1, 'latest JPEG frame route must exist');
const routeEnd = runtime.indexOf("if (req.method === 'POST' && url.pathname === '/speak')", routeStart);
assert.notEqual(routeEnd, -1, 'latest JPEG frame route must end before speak route');
const frameRoute = runtime.slice(routeStart, routeEnd);
assert.doesNotMatch(
  frameRoute,
  /readFileSync/,
  'latest JPEG frame route must not use synchronous request-path file reads'
);
assert.match(frameRoute, /await statExistingFileWithin/);
assert.match(frameRoute, /await pipeFileResponse/);
assert.match(frameRoute, /image\/jpeg/);
assert.match(frameRoute, /X-Floki-Frame-Timestamp/);
assert.match(frameRoute, /X-Floki-Frame-Age-Ms/);
assert.match(
  frameRoute,
  /await readStableFrameSnapshot/,
  'route must obtain an immutable snapshot before sending HTTP 200'
);
assert.match(
  frameRoute,
  /frame_snapshot_unstable/,
  'route must return a controlled retryable reason when no stable snapshot exists'
);
assert.match(frameRoute, /sendJson\(res, 503/, 'unstable snapshot must yield HTTP 503');
assert.match(
  frameRoute,
  /'Content-Length': snapshot\.buffer\.length/,
  'Content-Length must come from the exact immutable buffer being transmitted'
);
assert.doesNotMatch(
  frameRoute,
  /'Content-Length': frame\.stat\.size/,
  'Content-Length must not be derived from an earlier unrelated stat'
);
assert.match(frameRoute, /pipeFileResponse\(res, snapshot\.buffer/);

const snapshotStart = runtime.indexOf('async function readStableFrameSnapshot');
assert.notEqual(snapshotStart, -1, 'readStableFrameSnapshot helper must exist');
const snapshotSource = runtime.slice(snapshotStart, runtime.indexOf('\n}', snapshotStart));
assert.doesNotMatch(snapshotSource, /readFileSync/, 'snapshot must use asynchronous I/O only');
assert.match(snapshotSource, /fs\.promises\.open/);
assert.match(snapshotSource, /handle\.stat\(\)/, 'snapshot must verify metadata via the open handle');
assert.match(snapshotSource, /bytesRead === before\.size/);
assert.match(snapshotSource, /after\.size === before\.size/);
assert.match(snapshotSource, /after\.mtimeMs.*before\.mtimeMs/s, 'snapshot must reject frames rewritten during the read');
assert.match(snapshotSource, /FRAME_SNAPSHOT_MAX_ATTEMPTS/, 'snapshot retries must be bounded');
assert.match(snapshotSource, /before\.size > maxBytes/, 'snapshot must retain bounded maximum frame size');
assert.match(runtime, /0xff, 0xd8/, 'runtime must verify JPEG SOI bytes');
assert.match(runtime, /0xff, 0xd9/, 'runtime must verify JPEG EOI bytes');

const pipeStart = runtime.indexOf('function pipeFileResponse');
assert.notEqual(pipeStart, -1, 'pipeFileResponse must exist');
const pipeSource = runtime.slice(pipeStart, runtime.indexOf('\n}', pipeStart));
assert.match(pipeSource, /Buffer\.isBuffer\(source\)/, 'pipeFileResponse must accept an immutable Buffer source');
assert.match(pipeSource, /fs\.createReadStream\(source\)/, 'pipeFileResponse must retain file-path streaming for existing callers');

const adapter = text('apps/floki-neural-interface/src/integrations/floki/adapter.js');
assert.match(adapter, /https:\/\/api\.galactic-family-hub\.com/);
assert.match(adapter, /wss:\/\/api\.galactic-family-hub\.com\/ws/);
assert.match(adapter, /credentials:\s*'include'/);
assert.match(adapter, /async getVisionFrameBlob/);
assert.match(adapter, /accept:\s*'image\/jpeg'/);
assert.doesNotMatch(adapter, /new WebSocket\(['"`]http:\/\/127\.0\.0\.1/);
assert.match(adapter, /2 \*\* reconnectAttempts/);
assert.match(adapter, /socket && socket\.readyState < WebSocket\.CLOSING/);

const panel = text('apps/floki-neural-interface/src/components/vision/VisionPanel.jsx');
assert.match(panel, /new AbortController\(\)/);
assert.match(panel, /controller\.abort\(\)/);
assert.match(panel, /inFlight/);
assert.match(panel, /URL\.createObjectURL/);
assert.match(panel, /URL\.revokeObjectURL/);
assert.match(panel, /getVisionFrameBlob/);
assert.doesNotMatch(panel, /setInterval\(\(\) => \{\s*setPollKey/);
assert.doesNotMatch(panel, /jpgUrl \+ \(jpgUrl\.includes\('\?'\)/);

async function behavioralChecks() {
  const { pipeFileResponse, readStableFrameSnapshot } = require(
    path.join(ROOT, 'src/runtime/chat-local-runtime.cjs')
  );
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-frame-contract-'));
  const framePath = path.join(workDir, 'latest.jpg');
  const jpegBody = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(512, 0x33),
    Buffer.from([0xff, 0xd9])
  ]);
  try {
    fs.writeFileSync(framePath, jpegBody);
    const stable = await readStableFrameSnapshot(framePath, 8 * 1024 * 1024);
    assert.ok(stable, 'complete unchanged JPEG must produce a snapshot');
    assert.equal(Buffer.compare(stable.buffer, jpegBody), 0, 'snapshot must equal the on-disk bytes');
    assert.equal(stable.stat.size, jpegBody.length);

    const truncated = jpegBody.subarray(0, jpegBody.length - 1);
    fs.writeFileSync(framePath, truncated);
    const noEoi = await readStableFrameSnapshot(framePath, 8 * 1024 * 1024);
    assert.equal(noEoi, null, 'JPEG missing EOI must not produce a snapshot');

    fs.writeFileSync(framePath, jpegBody);
    const oversize = await readStableFrameSnapshot(framePath, jpegBody.length - 1);
    assert.equal(oversize, null, 'frame above the byte bound must not produce a snapshot');

    const missing = await readStableFrameSnapshot(path.join(workDir, 'absent.jpg'), 4096);
    assert.equal(missing, null, 'missing frame must not produce a snapshot');

    const server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/buffer') {
          await pipeFileResponse(res, jpegBody, {
            'Content-Type': 'image/jpeg',
            'Content-Length': jpegBody.length
          });
        } else {
          await pipeFileResponse(res, framePath, {
            'Content-Type': 'image/jpeg',
            'Content-Length': jpegBody.length
          });
        }
      } catch (_error) {
        res.destroy();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const fetchRaw = (pathname) =>
      new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }).on('error', reject);
      });
    try {
      const viaBuffer = await fetchRaw('/buffer');
      assert.equal(viaBuffer.res.statusCode, 200);
      assert.equal(Number(viaBuffer.res.headers['content-length']), viaBuffer.body.length);
      assert.equal(Buffer.compare(viaBuffer.body, jpegBody), 0, 'buffer transport must transmit exact snapshot bytes');
      const viaPath = await fetchRaw('/file');
      assert.equal(viaPath.res.statusCode, 200);
      assert.equal(Buffer.compare(viaPath.body, jpegBody), 0, 'file-path transport must keep working');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

behavioralChecks()
  .then(() => {
    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_PUBLIC_WEB_FRAME_TRANSPORT_CONTRACT_PASS',
      async_bounded_frame_endpoint: true,
      abortable_blob_polling: true,
      immutable_snapshot_transport: true
    }, null, 2));
  })
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_PUBLIC_WEB_FRAME_TRANSPORT_CONTRACT_FAIL',
      error: error.stack || error.message
    }, null, 2));
    process.exit(1);
  });
