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

if [ -f "$PID_FILE" ]; then
  PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "FLOKI_V2_SELF_IMPROVEMENT_ALREADY_RUNNING pid=$PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

setsid nohup bash "$NODE_RUN" node src/self-improvement/worker.cjs --service \
  >>"$LOG_FILE" 2>&1 < /dev/null &
PID="$!"
echo "$PID" > "$PID_FILE"

for _ in $(seq 1 "$START_ATTEMPTS"); do
  if ! kill -0 "$PID" 2>/dev/null; then
    tail -n "$START_LOG_TAIL_LINES" "$LOG_FILE" >&2 || true
    echo "FLOKI_V2_SELF_IMPROVEMENT_START_FAIL: worker exited" >&2
    exit 1
  fi

  if bash "$NODE_RUN" node - <<'NODE' >/dev/null 2>&1
const { readStatus } = require('./src/self-improvement/store.cjs');
const status = readStatus();
process.exit(status.worker_running ? 0 : 1);
NODE
  then
    echo "FLOKI_V2_SELF_IMPROVEMENT_START_PASS pid=$PID"
    exit 0
  fi

  sleep "$START_POLL_SECONDS"
done

echo "FLOKI_V2_SELF_IMPROVEMENT_START_FAIL: worker readiness timeout" >&2
exit 1
