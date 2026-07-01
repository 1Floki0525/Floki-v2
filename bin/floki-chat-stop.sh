#!/usr/bin/env bash


floki_node_24_or_newer() {
  local floki_node_version="${1:-}"
  local floki_node_major
  if [ -z "$floki_node_version" ]; then
    command -v node >/dev/null 2>&1 || return 1
    floki_node_version="$(node -v 2>/dev/null)" || return 1
  fi
  floki_node_version="${floki_node_version#v}"
  floki_node_major="${floki_node_version%%.*}"
  case "$floki_node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$floki_node_major" -ge 24 ]
}

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR=""
PID_FILE=""
COMPAT_PID_FILE=""

load_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 || ! floki_node_24_or_newer; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi
}

resolve_runtime_paths() {
  RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
process.stdout.write(path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root));
NODE
)" || exit 1
  PID_FILE="$RUNTIME_DIR/chat-local-runtime.pid"
  COMPAT_PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"
}

runtime_active() {
  CHECK_PID="$1"
  [ -n "$CHECK_PID" ] || return 1
  kill -0 "$CHECK_PID" >/dev/null 2>&1 || return 1
  if [ -r "/proc/$CHECK_PID/cmdline" ]; then
    CMDLINE="$(tr '\000' ' ' < "/proc/$CHECK_PID/cmdline")"
    case "$CMDLINE" in *src/runtime/chat-local-runtime.cjs*) return 0 ;; *) return 1 ;; esac
  fi
  return 1
}

cd "$PROJECT_DIR" || exit 1
load_node
resolve_runtime_paths
mkdir -p "$RUNTIME_DIR"
if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

PID=""
[ -f "$PID_FILE" ] && PID="$(cat "$PID_FILE" 2>/dev/null)"
if ! runtime_active "$PID"; then
  rm -f "$PID_FILE" "$COMPAT_PID_FILE"
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"already_stopped\":true,\"chat_mode_only\":true}"
  exit 0
fi

kill -TERM "$PID" >/dev/null 2>&1 || true
COUNT=0
while runtime_active "$PID" && [ "$COUNT" -lt 80 ]; do
  sleep 0.25
  COUNT=$((COUNT + 1))
done
if runtime_active "$PID"; then
  kill -KILL "$PID" >/dev/null 2>&1 || true
fi
rm -f "$PID_FILE" "$COMPAT_PID_FILE"
echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"stopped\":true,\"pid\":$PID,\"chat_mode_only\":true}"
