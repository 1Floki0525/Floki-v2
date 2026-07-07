#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_SERVICE="floki-chat-local-runtime.service"

fail() {
  echo "FLOKI_RUNTIME_SHUTDOWN_FAIL: $1" >&2
  exit 1
}

unit_exists() {
  systemctl --user list-unit-files \
    --type=service --no-legend "$1" 2>/dev/null |
    awk '{print $1}' |
    grep -Fxq "$1"
}

project_runtime_pids() {
  python3 - "$ROOT" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()

for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        cwd = Path(os.readlink(entry / 'cwd')).resolve()
        cmd = (
            (entry / 'cmdline')
            .read_bytes()
            .replace(b'\0', b' ')
            .decode('utf-8', 'replace')
        )
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        continue

    if cwd == root and \
       'src/runtime/chat-local-runtime.cjs' in cmd:
        print(entry.name)
PY
}

wait_for_pid_exit() {
  local pid="$1"
  for _ in $(seq 1 80); do
    kill -0 "$pid" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  return 1
}

cd "$ROOT" || fail "could not enter Floki-v2"

bash "$ROOT/bin/floki-app-stop.sh" ||
  fail "local Electron app did not stop"

if unit_exists "$TUNNEL_SERVICE"; then
  systemctl --user stop "$TUNNEL_SERVICE" ||
    fail "Omen reverse tunnel service did not stop"
fi

bash "$ROOT/bin/floki-self-improvement-stop.sh" ||
  fail "self-improvement worker or active sandbox did not stop"

bash "$ROOT/bin/floki-sleep-scheduler-stop.sh" ||
  fail "sleep scheduler did not stop"

if unit_exists "$RUNTIME_SERVICE"; then
  systemctl --user stop "$RUNTIME_SERVICE" ||
    fail "systemd could not stop the shared runtime service"
fi

bash "$ROOT/bin/floki-chat-stop.sh" ||
  fail "fallback runtime cleanup failed"

bash "$ROOT/bin/floki-chat-vision-stop.sh" \
  >/dev/null 2>&1 || true

mapfile -t REMAINING_PIDS < <(project_runtime_pids)

for pid in "${REMAINING_PIDS[@]}"; do
  kill -TERM "$pid" >/dev/null 2>&1 || true
done

for pid in "${REMAINING_PIDS[@]}"; do
  if ! wait_for_pid_exit "$pid"; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
done

mapfile -t FINAL_PIDS < <(project_runtime_pids)
[ "${#FINAL_PIDS[@]}" -eq 0 ] ||
  fail "project runtime processes remained active: ${FINAL_PIDS[*]}"

echo "FLOKI_RUNTIME_SHUTDOWN_PASS"
echo "electron_stopped=true"
echo "active_sandbox_stopped=true"
echo "self_improvement_worker_stopped=true"
echo "sleep_scheduler_stopped=true"
echo "runtime_service_stopped=true"
echo "vision_stop_requested=true"
echo "ollama_stopped=false"
echo "dreams_deleted=false"
echo "memories_deleted=false"
