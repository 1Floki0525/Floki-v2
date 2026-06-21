'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, 'state/floki/runtime');
const frameFile = path.join(TEST_DIR, 'chat-webcam-vision.latest-frame.jpg');

if (!fs.existsSync(frameFile)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const minJpeg = Buffer.alloc(100, 0xFF);
  minJpeg[0] = 0xFF; minJpeg[1] = 0xD8;
  minJpeg[minJpeg.length - 2] = 0xFF; minJpeg[minJpeg.length - 1] = 0xD9;
  fs.writeFileSync(frameFile, minJpeg);
}

const MJPEG_BOUNDARY = '--jpgliveboundary--';

function startMjpegTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url !== '/live.mjpeg') { res.writeHead(404).end(); return; }
      let lastMtime = 0;
      let closed = false;
      const listener = (curr) => {
        if (closed) return;
        if (curr.mtimeMs === lastMtime) return;
        lastMtime = curr.mtimeMs;
        try {
          const data = fs.readFileSync(frameFile);
          res.write('--' + MJPEG_BOUNDARY + '\r\nContent-Type: image/jpeg\r\nContent-Length: ' + data.length + '\r\n\r\n');
          res.write(data);
          res.write('\r\n');
        } catch (_) { /* ok */ }
      };
      req.on('close', () => { closed = true; try { fs.unwatchFile(frameFile, listener); } catch (_) { /* ok */ } });
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=' + MJPEG_BOUNDARY,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      fs.watchFile(frameFile, { interval: 20 }, listener);
      try { listener(fs.statSync(frameFile)); } catch (_) { /* ok */ }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function connectClient(server, minFrames) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:' + port + '/live.mjpeg', (res) => {
      let frameCount = 0;
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('binary');
        const boundary = '--' + MJPEG_BOUNDARY;
        let count = 0, idx = 0;
        while ((idx = buf.indexOf(boundary, idx)) !== -1) { count++; idx += boundary.length; }
        frameCount = count - 1;
        if (frameCount >= minFrames) { res.destroy(); resolve(frameCount); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function touchFrame() {
  try { fs.utimesSync(frameFile, new Date(), new Date()); } catch (_) { /* ok */ }
}

async function main() {
  const server = await startMjpegTestServer();
  console.log('MJPEG server started on port', server.address().port);

  // Test 1: Concurrent clients
  const client1 = connectClient(server, 2);
  const client2 = connectClient(server, 2);

  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 60));
    touchFrame();
  }

  const frames1 = await client1;
  const frames2 = await client2;
  assert(frames1 >= 2, 'Client 1: expected >=2 frames, got ' + frames1);
  assert(frames2 >= 2, 'Client 2: expected >=2 frames, got ' + frames2);
  console.log('Concurrent clients: ' + frames1 + ' and ' + frames2 + ' frames');

  // Test 2: Reconnect (client closes, new client connects)
  const client3 = connectClient(server, 2);
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 60));
    touchFrame();
  }
  const frames3 = await client3;
  assert(frames3 >= 2, 'Reconnect: expected >=2 frames, got ' + frames3);
  console.log('Reconnect: ' + frames3 + ' frames');

  server.close();
  console.log('PASS: mjpeg-continuity-contract');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
