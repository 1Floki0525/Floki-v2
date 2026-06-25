#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR=""
PID_FILE=""

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_STOP_ERROR\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}" >&2
  exit 1
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
  fi
}

resolve_runtime_paths() {
  RUNTIME_DIR="$(node - <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
process.stdout.write(path.resolve(PROJECT_ROOT, getPathConfig('chat').chat_runtime_root));
NODE
)" || fail "could not resolve chat runtime path from YAML"
  PID_FILE="$RUNTIME_DIR/sleep-cycle-scheduler.pid"
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

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"
load_node_24
resolve_runtime_paths
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
