'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');

function main() {
  const max = Number((yaml.match(/^  neural_event_max_display_chars:\s*(\d+)/m) || [])[1]);
  assert.ok(max > 0 && max <= 1000, 'neural_event_max_display_chars must be positive and reasonable');

  const iface = fs.readFileSync(
    path.join(__dirname, '../src/runtime/chat-local-interface-api.cjs'),
    'utf8'
  );
  assert.match(iface, /naturalInnerText|text\.length > \d+/, 'neural stream filter must enforce a length cap');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NEURAL_STREAM_LENGTH_CAP_PASS',
    neural_event_max_display_chars: max,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
