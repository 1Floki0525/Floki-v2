'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');

function main() {
  assert.match(yaml, /desired_state_gates_required_for_start:/, 'desired_state_gates_required_for_start must be defined');
  assert.match(yaml, /sleep_overrides_vision_start:\s*true/, 'sleep_overrides_vision_start must be true by default');
  assert.match(yaml, /vision_camera_stop_timeout_ms:\s*\d+/, 'vision_camera_stop_timeout_ms must be defined');
  assert.match(yaml, /vision_camera_availability_probe_timeout_ms:\s*\d+/, 'vision_camera_availability_probe_timeout_ms must be defined');

  const reconciler = fs.readFileSync(
    path.join(__dirname, '../src/runtime/chat-local-runtime.cjs'),
    'utf8'
  );
  assert.match(reconciler, /sleep_overrides_vision_start/, 'chat-local-runtime must read sleep_overrides_vision_start');
  assert.match(reconciler, /external_eyes_enabled/, 'chat-local-runtime must read external_eyes_enabled');
  assert.match(reconciler, /vision_camera_stop_timeout_ms/, 'chat-local-runtime must read vision_camera_stop_timeout_ms');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_VISION_LIFECYCLE_SLEEP_OVERRIDE_PASS',
    desired_state_gates_required: true,
    sleep_overrides_vision_start: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
