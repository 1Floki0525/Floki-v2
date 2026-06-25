#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR=""
PID_FILE=""
LOG_FILE=""

fail() {
  echo "{\"ok\":false,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_START_ERROR\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}" >&2
  exit 1
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "node was not found on PATH"
  fi

  NODE_VERSION="$(node -v 2>/dev/null)"
  case "$NODE_VERSION" in
    v24.17.0)
      ;;
    *)
      fail "Node v24.17.0 required, got $NODE_VERSION"
      ;;
  esac
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
  LOG_FILE="$RUNTIME_DIR/sleep-cycle-scheduler.log"
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

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"
load_node_24
resolve_runtime_paths
mkdir -p "$RUNTIME_DIR"

if [ "${FLOKI_SLEEP_SCHEDULER_SCRIPT_DRY_RUN:-0}" = "1" ]; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_START_PASS\",\"dry_run\":true,\"pid_file\":\"$PID_FILE\",\"log_file\":\"$LOG_FILE\",\"node_version\":\"$(node -v)\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 0
fi

EXISTING_PID=""
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null)"
fi

if scheduler_active "$EXISTING_PID"; then
  echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_START_PASS\",\"already_active\":true,\"pid\":$EXISTING_PID,\"pid_file\":\"$PID_FILE\",\"log_file\":\"$LOG_FILE\",\"node_version\":\"$(node -v)\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 0
fi

rm -f "$PID_FILE"

setsid node src/chat/sleep-cycle-scheduler.cjs --service </dev/null >> "$LOG_FILE" 2>&1 &
STARTED_PID="$!"
echo "$STARTED_PID" > "$PID_FILE"

COUNT=0
while ! scheduler_active "$STARTED_PID" && [ "$COUNT" -lt 20 ]; do
  sleep 0.25
  COUNT=$((COUNT + 1))
done

if ! scheduler_active "$STARTED_PID"; then
  tail -80 "$LOG_FILE" >&2 2>/dev/null
  fail "sleep-cycle scheduler process did not stay active"
fi

STATUS_ACTIVE="0"
COUNT=0
while [ "$STATUS_ACTIVE" != "1" ] && [ "$COUNT" -lt 20 ]; do
  STATUS_JSON="$(node src/chat/sleep-cycle-scheduler.cjs --status 2>/dev/null)"
  STATUS_ACTIVE="$(printf '%s' "$STATUS_JSON" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.active===true?'1':'0')})" 2>/dev/null)"
  if [ "$STATUS_ACTIVE" != "1" ]; then
    sleep 0.25
  fi
  COUNT=$((COUNT + 1))
done

if [ "$STATUS_ACTIVE" != "1" ]; then
  tail -80 "$LOG_FILE" >&2 2>/dev/null
  fail "sleep-cycle scheduler heartbeat did not become active"
fi

echo "{\"ok\":true,\"marker\":\"FLOKI_V2_SLEEP_CYCLE_SCHEDULER_START_PASS\",\"started\":true,\"pid\":$STARTED_PID,\"pid_file\":\"$PID_FILE\",\"log_file\":\"$LOG_FILE\",\"node_version\":\"$(node -v)\",\"chat_mode_only\":true,\"game_mode_started\":false}"
exit 0
