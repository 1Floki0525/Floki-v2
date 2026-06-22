#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/chat-local-runtime.pid"
STATUS_FILE="$RUNTIME_DIR/chat-local-runtime.status.json"
PID=""
[ -f "$PID_FILE" ] && PID="$(cat "$PID_FILE" 2>/dev/null)"
ACTIVE=false
if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then ACTIVE=true; fi

if [ -f "$STATUS_FILE" ]; then
  node - "$STATUS_FILE" "$ACTIVE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const active = process.argv[3] === 'true';
let status;
try { status = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { status = { error: error.message }; }
console.log(JSON.stringify({
  ok: active && status.ok !== false,
  marker: active ? 'FLOKI_V2_CHAT_STATUS_SCRIPT_PASS' : 'FLOKI_V2_CHAT_STATUS_SCRIPT_INACTIVE',
  active,
  runtime: status,
  chat_mode_only: true
}, null, 2));
NODE
else
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_CHAT_STATUS_SCRIPT_INACTIVE\",\"active\":$ACTIVE,\"chat_mode_only\":true}"
fi
