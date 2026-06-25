'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createMjpegFileStreamServer } = require('../apps/floki-neural-interface/electron/mjpeg-file-stream.cjs');
const { createChatLocalInterfaceApi } = require('../src/runtime/chat-local-interface-api.cjs');
const { runtimePaths } = require('../src/vision/chat-webcam-vision-service.cjs');

function jpeg(label) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(label), 'utf8'), Buffer.from([0xff, 0xd9])]);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function receiveFrames(url, expectedFrames, update) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let updated = false;
    const request = http.get(url, (response) => {
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type'] || ''), /^multipart\/x-mixed-replace; boundary=flokiliveboundary$/);
      response.on('data', (chunk) => {
        chunks.push(chunk);
        const value = Buffer.concat(chunks);
        if (!updated && value.includes(Buffer.from('frame-one'))) {
          updated = true;
          update();
        }
        const matches = value.toString('latin1').match(/--flokiliveboundary/g) || [];
        if (matches.length >= expectedFrames && value.includes(Buffer.from('frame-two'))) {
          request.destroy();
          resolve(value);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('MJPEG frame timeout')));
    request.on('error', reject);
  });
}


function staleThenFresh(url, frameFile) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const request = http.get(url, (response) => {
      assert.equal(response.statusCode, 200);
      response.on('data', (chunk) => {
        chunks.push(chunk);
        const value = Buffer.concat(chunks);
        if (value.includes(Buffer.from('stale-frame'))) {
          request.destroy(new Error('stale frame was streamed'));
          return;
        }
        if (value.includes(Buffer.from('fresh-after-stale'))) {
          request.destroy();
          resolve(value);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('fresh recovery frame timeout')));
    request.on('error', reject);
    setTimeout(() => {
      const before = Buffer.concat(chunks);
      if (before.includes(Buffer.from('stale-frame'))) {
        request.destroy(new Error('stale frame was streamed before recovery'));
        return;
      }
      fs.writeFileSync(frameFile, jpeg('fresh-after-stale'));
    }, 150);
  });
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-live-video-recovery-'));
  const frameFile = path.join(root, 'latest-frame.jpg');
  fs.writeFileSync(frameFile, jpeg('frame-one'));

  const transport = createMjpegFileStreamServer({
    frame_file: frameFile,
    freshness_ms: 2000,
    watch_interval_ms: 25
  });
  const port = await transport.start();
  const bytes = await receiveFrames(`http://127.0.0.1:${port}/live.mjpeg`, 2, () => {
    setTimeout(() => fs.writeFileSync(frameFile, jpeg('frame-two')), 40);
  });
  assert.equal(bytes.includes(Buffer.from('frame-one')), true);
  assert.equal(bytes.includes(Buffer.from('frame-two')), true);
  assert.equal(bytes.includes(Buffer.from('data:image/jpeg;base64,')), false);
  transport.close();

  const staleTransportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-stale-mjpeg-'));
  const staleTransportFrame = path.join(staleTransportRoot, 'latest-frame.jpg');
  fs.writeFileSync(staleTransportFrame, jpeg('stale-frame'));
  const oldTransportTime = new Date(Date.now() - 120000);
  fs.utimesSync(staleTransportFrame, oldTransportTime, oldTransportTime);
  const staleTransport = createMjpegFileStreamServer({
    frame_file: staleTransportFrame,
    freshness_ms: 100,
    watch_interval_ms: 25
  });
  const stalePort = await staleTransport.start();
  const recoveredBytes = await staleThenFresh(`http://127.0.0.1:${stalePort}/live.mjpeg`, staleTransportFrame);
  assert.equal(recoveredBytes.includes(Buffer.from('stale-frame')), false);
  assert.equal(recoveredBytes.includes(Buffer.from('fresh-after-stale')), true);
  staleTransport.close();

  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-live-video-stale-'));
  const paths = runtimePaths({ runtime_dir: staleRoot });
  fs.mkdirSync(staleRoot, { recursive: true });
  fs.writeFileSync(paths.latest_frame_file, jpeg('live-frame'));
  fs.writeFileSync(paths.pid_file, String(process.pid) + '\n');
  writeJson(paths.status_file, {
    active: true,
    camera_open: true,
    measured_capture_fps: 40,
    latest_private_observation_file: paths.latest_observation_file
  });
  writeJson(paths.heartbeat_file, { service_heartbeat: new Date().toISOString() });
  writeJson(paths.latest_observation_file, {
    ok: true,
    created_at: new Date().toISOString(),
    source: 'webcam',
    observation_summary: 'A current live room observation.',
    public_transcript_visible: false
  });
  writeJson(path.join(staleRoot, 'chat-webcam-vision.latest-detection.json'), {
    ok: true,
    schema_version: 1,
    frame_id: 'live-video-recovery-frame',
    captured_at: new Date().toISOString(),
    stored_at: new Date().toISOString(),
    detected_at: new Date().toISOString(),
    image_width: 1280,
    image_height: 720,
    device: 'test',
    model_source: 'behavioral_fixture',
    stale: false,
    age_ms: 0,
    detections: [
      {
        id: 'person-live',
        class_id: 0,
        type: 'person',
        label: 'person',
        confidence: 0.95,
        source: 'yolo',
        proposal_sources: ['yolo', 'grounding_dino'],
        bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.7 }
      }
    ]
  });

  const api = createChatLocalInterfaceApi({
    runtime_dir: staleRoot,
    status: () => ({ api_ready: true, brain_loaded: true, websocket_ready: true })
  });
  const live = api.buildVisionFrame();
  assert.equal(live.connectionStatus, 'active');
  assert.equal(live.frame.fresh, true);
  assert.equal(live.persons.length, 1);

  const old = new Date(Date.now() - 120000);
  fs.utimesSync(paths.latest_frame_file, old, old);
  const stale = api.buildVisionFrame();
  assert.notEqual(stale.connectionStatus, 'active');
  assert.equal(stale.frame.fresh, false);
  assert.equal(stale.frame.stale, true);
  assert.deepEqual(stale.objects, []);
  assert.deepEqual(stale.persons, []);
  assert.equal(stale.scene.available, false);
  assert.equal(api.latestFrameBase64(), null);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_LIVE_VIDEO_RECOVERY_PASS',
    file_backed_mjpeg_frames: 2,
    base64_proxy_removed: true,
    stale_mjpeg_frame_suppressed: true,
    fresh_stream_recovery: true,
    stale_frame_cannot_report_live: true,
    stale_detection_overlays_cleared: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_LOCAL_LIVE_VIDEO_RECOVERY_FAIL',
    error: error && error.stack ? error.stack : String(error),
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
