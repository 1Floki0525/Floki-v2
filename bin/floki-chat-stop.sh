#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/chat-local-runtime.pid"
COMPAT_PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"

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
