#!/usr/bin/env bash

PROJECT_DIR="/media/binary-god/1tb-ssd/Floki-v2"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/chat-mode-loop.pid"
STOP_FILE="$RUNTIME_DIR/chat-mode-loop.stop"

runner_active() {
  CHECK_PID="$1"

  if [ -z "$CHECK_PID" ]; then
    return 1
  fi

  if ! kill -0 "$CHECK_PID" >/dev/null 2>&1; then
    return 1
  fi

  if [ -r "/proc/$CHECK_PID/cmdline" ]; then
    CMDLINE="$(tr '\000' ' ' < "/proc/$CHECK_PID/cmdline")"
    case "$CMDLINE" in
      *floki-chat-start.sh*"--runner"*)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  fi

  return 1
}

mkdir -p "$RUNTIME_DIR"

if [ "${FLOKI_CHAT_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

PID=""
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null)"
fi

if ! runner_active "$PID"; then
  rm -f "$PID_FILE"
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"already_stopped\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
  exit 0
fi

touch "$STOP_FILE"
kill "$PID" >/dev/null 2>&1

COUNT=0
while runner_active "$PID" && [ "$COUNT" -lt 20 ]; do
  sleep 0.25
  COUNT=$((COUNT + 1))
done

if runner_active "$PID"; then
  kill -TERM "$PID" >/dev/null 2>&1
fi

rm -f "$PID_FILE"

echo "{\"ok\":true,\"marker\":\"FLOKI_V2_CHAT_STOP_SCRIPT_PASS\",\"stopped\":true,\"pid\":$PID,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true}"
exit 0
