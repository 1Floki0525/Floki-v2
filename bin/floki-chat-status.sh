#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
load_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -Eq '^v24\.'; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi
}

cd "$PROJECT_DIR" || exit 1
load_node
RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
process.stdout.write(path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root));
NODE
)" || exit 1
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
