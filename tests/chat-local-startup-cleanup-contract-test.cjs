"use strict";

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const service = read('src/vision/chat-webcam-vision-service.cjs');
const runtimeCommand = read('bin/floki-runtime.sh');
const visionStart = read('bin/floki-chat-vision-start.sh');
const cleanup = read('bin/floki-chat-local-cleanup.sh');
const localStart = read('bin/floki-chat-local-start.sh');
const electronMain = read(
  'apps/floki-neural-interface/electron/main.cjs'
);
const yoloService = read('src/vision/yolo-detection-service.cjs');

assert.match(service, /function readyTimeoutMs\(/);
assert.match(service, /getTimeoutConfig\('chat'\)/);
assert.match(service, /model_warmup_ms/);
assert.match(service, /grounding-dino-worker\.py/);
assert.match(service, /targets\.has\(processInfo\.parent_pid\)/);

const readyFunction = service.match(
  /function statusReadyForChat\(status\) \{[\s\S]*?\n\}/
);
assert.ok(readyFunction, 'statusReadyForChat must exist');
assert.match(readyFunction[0], /first_vlm_observation_succeeded/);

const retiredLauncherName = 'floki-' + 'start.sh';
assert.equal(
  fs.existsSync(path.join(root, 'bin', retiredLauncherName)),
  false
);
assert.equal(
  fs.existsSync(
    path.join(root, 'src/runtime/chat-local-supervisor-lease.cjs')
  ),
  false
);

const stopBlock = runtimeCommand.slice(
  runtimeCommand.indexOf('  stop)'),
  runtimeCommand.indexOf('  restart|reset)')
);
const requiredStopOrder = [
  'stop_app',
  'floki-chat-stop.sh',
  'floki-self-improvement-stop.sh',
  'floki-sleep-scheduler-stop.sh',
  'floki-chat-vision-stop.sh',
  'stop_managed_units',
  'stop_project_processes',
  'stop_configured_model_containers',
  'unload_configured_models',
  'release_gpu_owner',
  'verify_shutdown_quiescence'
];
let previous = -1;
for (const label of requiredStopOrder) {
  const index = stopBlock.indexOf(label);
  assert.notEqual(index, -1, 'missing stop stage: ' + label);
  assert.ok(index > previous, 'stop stage out of order: ' + label);
  previous = index;
}
assert.match(stopBlock, /chat-local-supervisor-session\.json/);
assert.match(stopBlock, /chat-local-supervisor\.lock/);

assert.match(cleanup, /FLOKI_CHAT_LOCAL_CLEANUP_DELEGATED/);
assert.match(cleanup, /exec bash "\$ROOT\/bin\/floki-runtime\.sh" stop/);
assert.doesNotMatch(cleanup, /chat-local-cleanup-ownership\.cjs/);
assert.doesNotMatch(cleanup, /chat-local-supervisor-lease\.cjs/);

assert.match(visionStart, /--kill-after=5s 45s/);
assert.match(visionStart, /handle_interrupt/);
assert.match(visionStart, /floki-chat-local-cleanup\.sh/);

assert.match(localStart, /\[FLOKI STARTUP 6\/7\]/);
assert.match(localStart, /\[FLOKI STARTUP 7\/7\]/);

const ensureRuntimeIndex = electronMain.indexOf('ensureRuntime();');
const createWindowIndex = electronMain.indexOf('createWindow();');
assert.ok(ensureRuntimeIndex >= 0);
assert.ok(createWindowIndex > ensureRuntimeIndex);

assert.match(yoloService, /worker\.stdin\.on\('error'/);
assert.match(yoloService, /error\.code\s*!==\s*'EPIPE'/);
assert.match(yoloService, /stdin\.destroyed/);
assert.match(yoloService, /stdin\.writableEnded/);
assert.match(yoloService, /settlePendingYoloFailure/);

const statusReadyForChat = Function(
  '"use strict"; return (' + readyFunction[0] + ');'
)();

assert.equal(statusReadyForChat({
  service_process_alive: true,
  ffmpeg_process_alive: true,
  camera_open: true,
  first_frame_received: true,
  first_vlm_observation_succeeded: false,
  last_fatal_error: null
}), false);

assert.equal(statusReadyForChat({
  service_process_alive: true,
  ffmpeg_process_alive: true,
  camera_open: false,
  first_frame_received: true,
  last_fatal_error: null
}), false);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_CHAT_LOCAL_LIFECYCLE_V2_CONTRACT_PASS',
  sole_runtime_authority: 'bin/floki-runtime.sh',
  complete_stop_order_verified: true,
  compatibility_cleanup_delegates_only: true,
  retired_launcher_absent: true,
  retired_supervisor_lease_absent: true,
  gui_waits_for_qwen_scene: true,
  live_services_started_by_test: false
}, null, 2));
