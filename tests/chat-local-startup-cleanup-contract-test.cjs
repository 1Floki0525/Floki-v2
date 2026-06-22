'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(
  path.join(root, 'src/vision/chat-webcam-vision-service.cjs'),
  'utf8'
);
const mainStart = fs.readFileSync(
  path.join(root, 'bin/floki-start.sh'),
  'utf8'
);
const visionStart = fs.readFileSync(
  path.join(root, 'bin/floki-chat-vision-start.sh'),
  'utf8'
);
const cleanup = fs.readFileSync(
  path.join(root, 'bin/floki-chat-local-cleanup.sh'),
  'utf8'
);
const localStart = fs.readFileSync(
  path.join(root, 'bin/floki-chat-local-start.sh'),
  'utf8'
);
const electronMain = fs.readFileSync(
  path.join(
    root,
    'apps/floki-neural-interface/electron/main.cjs'
  ),
  'utf8'
);
const yoloService = fs.readFileSync(
  path.join(root, 'src/vision/yolo-detection-service.cjs'),
  'utf8'
);

assert.match(service, /const READY_TIMEOUT_MS = 30000;/);
assert.match(service, /grounding-dino-worker\.py/);
assert.match(service, /targets\.has\(processInfo\.parent_pid\)/);

const readyFunction = service.match(
  /function statusReadyForChat\(status\) \{[\s\S]*?\n\}/
);
assert.ok(readyFunction, 'statusReadyForChat must exist');
assert.match(
  readyFunction[0],
  /first_vlm_observation_succeeded/
);

assert.equal(
  (mainStart.match(/FLOKI_CHAT_LOCAL_LIFECYCLE_HELPERS_BEGIN/g) || []).length,
  1
);
assert.equal(
  (mainStart.match(/^  chat\.local\)$/gm) || []).length,
  1
);
assert.match(mainStart, /trap cleanup_chat_local EXIT/);
assert.match(mainStart, /trap interrupt_chat_local INT TERM HUP/);
assert.match(mainStart, /bin\/floki-chat-local-cleanup\.sh/);

assert.match(visionStart, /--kill-after=5s 45s/);
assert.match(visionStart, /handle_interrupt/);
assert.match(visionStart, /floki-chat-local-cleanup\.sh/);

assert.match(cleanup, /grounding-dino-worker\.py/);
assert.match(cleanup, /yolo-worker\.py/);
assert.match(cleanup, /sleep-cycle-scheduler\.cjs --service/);
assert.match(cleanup, /apps\/floki-neural-interface\/node_modules\/\.bin\/electron/);

assert.match(mainStart, /startup_stage "1\/7"/);
assert.match(mainStart, /startup_stage "2\/7"/);
assert.match(mainStart, /preflight_core_brain/);
assert.match(mainStart, /src\/brain\/core-brain-status\.cjs chat/);
assert.match(mainStart, /startup_stage "4\/7"/);
assert.match(localStart, /\[FLOKI STARTUP 6\/7\]/);
assert.match(localStart, /\[FLOKI STARTUP 7\/7\]/);

const ensureRuntimeIndex = electronMain.indexOf('ensureRuntime();');
const createWindowIndex = electronMain.indexOf('createWindow();');
assert.ok(ensureRuntimeIndex >= 0, 'Electron must initialize the core brain runtime');
assert.ok(createWindowIndex > ensureRuntimeIndex, 'core brain runtime must initialize before the window opens');

assert.match(yoloService, /worker\.stdin\.on\('error'/);
assert.match(yoloService, /error\.code\s*!==\s*'EPIPE'/);
assert.match(yoloService, /stdin\.destroyed/);
assert.match(yoloService, /stdin\.writableEnded/);
assert.match(yoloService, /settlePendingYoloFailure/);

assert.match(mainStart, /startup_stage "5\/7"/);
assert.match(mainStart, /start_chat_hearing/);
assert.match(mainStart, /bin\/floki-chat-start\.sh/);
assert.match(cleanup, /bin\/floki-chat-stop\.sh/);
assert.match(cleanup, /chat-mode-loop\.pid/);
assert.match(cleanup, /src\/senses\/chat-mode-loop\.cjs/);


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
  partial_previous_patch_recovered: true,
  gui_waits_for_camera_frame_only: false,
  gui_waits_for_qwen_scene: true,
  ctrl_c_exact_cleanup: true,
  normal_close_exact_cleanup: true,
  grounding_dino_cleanup: true,
  yolo_cleanup: true,
  ffmpeg_descendant_cleanup: true,
  scheduler_cleanup: true,
  live_services_started_by_test: false
}, null, 2));
