'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runtimePaths,
  stopChatWebcamVisionService
} = require('../src/vision/chat-webcam-vision-service.cjs');

async function run() {
  assert.equal(
    Number(process.versions.node.split('.')[0]) >= 24,
    true,
    'Node 24 or newer is required'
  );
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-chat-webcam-stop-'));
  const paths = runtimePaths({ runtime_dir: runtimeDir });
  fs.writeFileSync(paths.pid_file, '4242\n');
  const killed = [];
  let alive = true;
  const status = await stopChatWebcamVisionService({
    runtime_dir: runtimeDir,
    timeout_ms: 1000,
    stop_tunnel: false,
    process_is_alive: (pid) => pid === 4242 && alive,
    kill_process: (pid, signal) => {
      killed.push({ pid, signal });
      alive = false;
    }
  });

  assert.equal(status.ok, true);
  assert.equal(status.marker, 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STOPPED');
  assert.equal(status.active, false);
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGTERM' }]);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_WEBCAM_SHUTDOWN_PASS',
    chat_exit_stops_webcam_service: true,
    service_pid_signaled: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_WEBCAM_SHUTDOWN_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
});
