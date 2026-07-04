#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_RUN="$ROOT/bin/floki-node24-run.sh"

config_value() {
  bash "$NODE_RUN" node src/self-improvement/config-cli.cjs "$1"
}

RUNTIME_ROOT="$(config_value runtime_root)"
PID_FILE="$RUNTIME_ROOT/$(config_value worker_pid_file_name)"
STOP_ATTEMPTS="$(config_value service_stop_attempts)"
STOP_POLL_SECONDS="$(config_value service_stop_poll_seconds)"

bash "$NODE_RUN" node - <<'NODE' || true
const { stopCurrentContainer } = require('./src/self-improvement/sandbox.cjs');
stopCurrentContainer('service_stop');
NODE

if [ ! -f "$PID_FILE" ]; then
  echo "FLOKI_V2_SELF_IMPROVEMENT_STOP_PASS already_stopped=true"
  exit 0
fi

worker_active() {
  local check_pid="$1"
  [ -n "$check_pid" ] || return 1
  kill -0 "$check_pid" 2>/dev/null || return 1
  # Guard against recycled PIDs: only treat the process as ours when its
  # command line is the self-improvement worker.
  if [ -r "/proc/$check_pid/cmdline" ]; then
    tr '\000' ' ' < "/proc/$check_pid/cmdline" | grep -q 'src/self-improvement/worker\.cjs' || return 1
  fi
  return 0
}

PID="$(tr -cd '0-9' < "$PID_FILE")"
if worker_active "$PID"; then
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 "$STOP_ATTEMPTS"); do
    worker_active "$PID" || break
    sleep "$STOP_POLL_SECONDS"
  done
  if worker_active "$PID"; then
    kill -KILL "$PID" 2>/dev/null || true
    for _ in $(seq 1 "$STOP_ATTEMPTS"); do
      worker_active "$PID" || break
      sleep "$STOP_POLL_SECONDS"
    done
  fi
fi

if worker_active "$PID"; then
  echo "FLOKI_V2_SELF_IMPROVEMENT_STOP_FAIL pid=$PID reason=worker_survived_sigkill" >&2
  exit 1
fi

rm -f "$PID_FILE"
echo "FLOKI_V2_SELF_IMPROVEMENT_STOP_PASS"
