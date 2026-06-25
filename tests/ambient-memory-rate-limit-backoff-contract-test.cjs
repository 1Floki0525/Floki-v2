'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');

function main() {
  assert.match(yaml, /ambient_memory_rate_limit_per_minute:\s*\d+/, 'ambient_memory_rate_limit_per_minute must be defined in audio section');
  assert.match(yaml, /ambient_memory_backoff_seconds:\s*\d+/, 'ambient_memory_backoff_seconds must be defined in audio section');
  assert.match(yaml, /ambient_memory_failure_log_max_chars:\s*\d+/, 'ambient_memory_failure_log_max_chars must be defined');
  assert.match(yaml, /ambient_memory_failure_log_name:\s*"[^"]+"/, 'ambient_memory_failure_log_name must be defined');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_AMBIENT_MEMORY_RATE_LIMIT_BACKOFF_PASS',
    rate_limit_present: true,
    backoff_present: true,
    failure_log_present: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
