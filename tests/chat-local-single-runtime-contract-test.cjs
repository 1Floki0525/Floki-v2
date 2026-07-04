'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');

function read(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); }
function run() {
  const runtime = read('src/runtime/chat-local-runtime.cjs');
  const electron = read('apps/floki-neural-interface/electron/main.cjs');
  const start = read('bin/floki-chat-start.sh');
  const localStart = read('bin/floki-chat-local-start.sh');

  assert.match(runtime, /const brain = options\.runtime \|\| createRuntime/);
  assert.match(runtime, /enqueueTurn/);
  assert.match(runtime, /input_modality: 'spoken'/);
  assert.match(runtime, /input_modality: 'text'/);
  assert.match(runtime, /on_ambient_observation: rememberAmbient/);
  assert.match(runtime, /await liveAudio\.setAwake\(hearingEnabled\)/);
  assert.match(runtime, /const visionEnabled = awake && allGatesPass/);
  assert.match(runtime, /filter\(\(gate\) => gate !== 'client_ready' && gate !== 'window_visible'\)/);
  assert.match(runtime, /createVisionReconciler\(/);
  assert.match(runtime, /visionReconciler\.reconcile\(visionEnabled/);
  assert.match(runtime, /stopChatWebcamVisionService/);
  assert.match(runtime, /startChatWebcamVisionService/);
  assert.match(runtime, /chat-webcam-vision\.refresh-request\.json/);
  assert.match(runtime, /url\.pathname === '\/client-ready'/);
  assert.match(runtime, /initial_awake: false/);
  assert.match(electron, /runtimeRequest\('POST', '\/client-ready'/);
  assert.doesNotMatch(electron, /createRuntime\s*\(/);
  assert.doesNotMatch(electron, /handleTypedText\s*\(/);
  assert.match(electron, /runtimeRequest\('POST', '\/chat'/);
  assert.match(start, /src\/runtime\/chat-local-runtime\.cjs/);
  assert.match(localStart, /authoritative live runtime/);

  console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_CHAT_LOCAL_SINGLE_RUNTIME_CONTRACT_PASS', one_backend_brain_owner: true, typed_and_spoken_share_queue: true, electron_is_client_only: true, client_presence_is_telemetry_only: true, sleep_gates_hearing_and_vision: true, fresh_vision_request_supported: true, chat_mode_only: true }, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_LOCAL_SINGLE_RUNTIME_CONTRACT_FAIL', error: error.message }, null, 2)); process.exit(1); }
