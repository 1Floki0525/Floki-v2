#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_RUN="$ROOT/bin/floki-node24-run.sh"

config_value() {
  bash "$NODE_RUN" node src/self-improvement/config-cli.cjs "$1"
}

ENGINE="$(config_value sandbox_engine)"
RUNTIME_ROOT="$(config_value runtime_root)"
PID_FILE="$RUNTIME_ROOT/$(config_value worker_pid_file_name)"
LOG_FILE="$RUNTIME_ROOT/$(config_value worker_log_name)"
START_ATTEMPTS="$(config_value service_start_attempts)"
START_POLL_SECONDS="$(config_value service_start_poll_seconds)"
START_LOG_TAIL_LINES="$(config_value service_start_log_tail_lines)"

command -v "$ENGINE" >/dev/null 2>&1 || {
  echo "FLOKI_V2_SELF_IMPROVEMENT_START_FAIL: configured sandbox engine is unavailable: $ENGINE" >&2
  exit 1
}

mkdir -p "$RUNTIME_ROOT"

worker_active() {
  local check_pid="${1:-}"
  [ -n "$check_pid" ] || return 1
  kill -0 "$check_pid" 2>/dev/null || return 1
  if [ -r "/proc/$check_pid/cmdline" ]; then
    tr '\000' ' ' < "/proc/$check_pid/cmdline" | grep -q 'src/self-improvement/worker\.cjs' || return 1
  else
    return 1
  fi
  return 0
}

status_ready_for_pid() {
  local check_pid="$1"
  bash "$NODE_RUN" node - "$check_pid" <<'NODE' >/dev/null 2>&1
'use strict';
const pid = Number(process.argv[2]);
const { readStatus } = require('./src/self-improvement/store.cjs');
const status = readStatus();
if (status.worker_running !== true) process.exit(1);
if (Number(status.worker_pid) !== Number(pid)) process.exit(1);
if (status.model_proxy_ready !== true) process.exit(1);
process.exit(0);
NODE
}

if [ -f "$PID_FILE" ]; then
  PID="$(tr -cd '0-9' < "$PID_FILE")"
  if worker_active "$PID"; then
    echo "FLOKI_V2_SELF_IMPROVEMENT_ALREADY_RUNNING pid=$PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

setsid nohup bash "$NODE_RUN" node src/self-improvement/worker.cjs --service \
  >>"$LOG_FILE" 2>&1 < /dev/null &
PID="$!"
printf '%s\n' "$PID" > "$PID_FILE"

for _ in $(seq 1 "$START_ATTEMPTS"); do
  if ! worker_active "$PID"; then
    tail -n "$START_LOG_TAIL_LINES" "$LOG_FILE" >&2 || true
    echo "FLOKI_V2_SELF_IMPROVEMENT_START_FAIL: worker exited before readiness pid=$PID" >&2
    exit 1
  fi

  if status_ready_for_pid "$PID"; then
    echo "FLOKI_V2_SELF_IMPROVEMENT_START_PASS pid=$PID"
    exit 0
  fi

  sleep "$START_POLL_SECONDS"
done

tail -n "$START_LOG_TAIL_LINES" "$LOG_FILE" >&2 || true
echo "FLOKI_V2_SELF_IMPROVEMENT_START_FAIL: worker readiness timeout pid=$PID" >&2
exit 1
