#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$PROJECT_DIR/state/floki/chat/runtime"
PID_FILE="$RUNTIME_DIR/sleep-cycle-scheduler.pid"

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOP_ERROR\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}" >&2
  exit 1
}

scheduler_active() {
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
      *sleep-cycle-scheduler.cjs*"--service"*)
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

if [ "${FLOKI_SLEEP_SCHEDULER_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOP_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 0
fi

PID=""
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null)"
fi

if ! scheduler_active "$PID"; then
  rm -f "$PID_FILE"
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOP_PASS\",\"already_stopped\":true,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 0
fi

kill -TERM "$PID" >/dev/null 2>&1

COUNT=0
while scheduler_active "$PID" && [ "$COUNT" -lt 20 ]; do
  sleep 0.25
  COUNT=$((COUNT + 1))
done

if scheduler_active "$PID"; then
  kill -KILL "$PID" >/dev/null 2>&1
  sleep 0.25
fi

if scheduler_active "$PID"; then
  fail "sleep-cycle scheduler remained active after stop request"
fi

rm -f "$PID_FILE"
echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOP_PASS\",\"stopped\":true,\"pid\":$PID,\"pid_file\":\"$PID_FILE\",\"chat_mode_only\":true,\"game_mode_started\":false}"
exit 0
