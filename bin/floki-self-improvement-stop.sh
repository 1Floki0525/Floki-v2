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

PID="$(tr -cd '0-9' < "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 "$STOP_ATTEMPTS"); do
    kill -0 "$PID" 2>/dev/null || break
    sleep "$STOP_POLL_SECONDS"
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null || true
  fi
fi

rm -f "$PID_FILE"
echo "FLOKI_V2_SELF_IMPROVEMENT_STOP_PASS"
