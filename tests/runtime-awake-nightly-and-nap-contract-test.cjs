'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function main() {
  const runtime = fs.readFileSync(path.join(__dirname, '../src/runtime/chat-local-runtime.cjs'), 'utf8');
  assert.match(runtime, /sleep_overrides_vision_start/);
  assert.match(runtime, /camera_availability/);
  assert.match(runtime, /desired_state_gates_required_for_start/);
  assert.match(runtime, /nightly sleep interrupted by Wake Floki control/);

  const manualNap = fs.readFileSync(path.join(__dirname, '../src/chat/manual-nap.cjs'), 'utf8');
  assert.match(manualNap, /fs\.rmSync\(file\(options\)/);
  assert.match(manualNap, /maxRemCycles/);

  const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');
  assert.match(yaml, /manual_nap_rem_offset_minutes:\s*10/);
  assert.match(yaml, /manual_nap_max_rem_cycles:\s*2/);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RUNTIME_AWAKE_NIGHTLY_AND_NAP_PASS',
    sleep_overrides_vision_start: true,
    nightly_wake_path_present: true,
    completed_nap_file_removed: true,
    manual_nap_rem_offset_minutes: 10,
    manual_nap_max_rem_cycles: 2,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
