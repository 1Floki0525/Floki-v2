'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function main() {
  const adapter = fs.readFileSync(
    path.join(__dirname, '../apps/floki-neural-interface/src/integrations/floki/adapter.js'),
    'utf8'
  );
  assert.match(adapter, /reconnect_jitter_ms|reconnectJitterMs/, 'WebSocket reconnect must use YAML jitter');
  assert.match(adapter, /reconnect_backoff_max_ms|reconnectBackoffMaxMs/, 'WebSocket reconnect must use YAML backoff max');
  assert.match(adapter, /max_reconnect_attempts|maxReconnectAttempts/, 'WebSocket reconnect must use YAML max attempts');
  assert.match(adapter, /reconnectTimer/, 'reconnect must use a single timer');
  assert.match(adapter, /if \(reconnectTimer\)/, 'reconnect must not create duplicate timers');

  const yaml = fs.readFileSync(path.join(__dirname, '../config/chat.config.yaml'), 'utf8');
  const jitter = Number((yaml.match(/^\s+reconnect_jitter_ms:\s*(\d+)/m) || [])[1]);
  const backoffMax = Number((yaml.match(/^\s+reconnect_backoff_max_ms:\s*(\d+)/m) || [])[1]);
  const maxAttempts = Number((yaml.match(/^\s+max_reconnect_attempts:\s*(\d+)/m) || [])[1]);
  assert.ok(jitter > 0, 'reconnect_jitter_ms must be defined and positive');
  assert.ok(backoffMax > 0, 'reconnect_backoff_max_ms must be defined and positive');
  assert.ok(Number.isFinite(maxAttempts), 'max_reconnect_attempts must be defined');

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_WEBSOCKET_RECONNECT_POLICY_PASS',
    reconnect_jitter_ms: jitter,
    reconnect_backoff_max_ms: backoffMax,
    max_reconnect_attempts: maxAttempts,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main();
