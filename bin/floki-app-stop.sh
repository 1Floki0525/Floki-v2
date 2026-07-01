#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/apps/floki-neural-interface"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"
RUNTIME_DIR=""
PID_FILE=""

fail() {
  echo "FLOKI_APP_STOP_FAIL: $1" >&2
  exit 1
}

resolve_paths() {
  RUNTIME_DIR="$(
    bash "$NODE_RUN" node - <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getPathConfig
} = require('./src/config/floki-config.cjs');

process.stdout.write(
  path.resolve(
    PROJECT_ROOT,
    getPathConfig('chat').chat_runtime_root
  )
);
NODE
  )" || fail "could not resolve runtime path from chat YAML"

  PID_FILE="$RUNTIME_DIR/floki-app.pid"
}

electron_main_active() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  [ -L "/proc/$pid/cwd" ] || return 1

  local cwd
  local cmdline
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  cmdline="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"

  [ "$cwd" = "$APP_DIR" ] || return 1
  case "$cmdline" in
    *electron*)
      case "$cmdline" in
        *"--type="*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

discover_electron_main() {
  python3 - "$APP_DIR" <<'PY'
import os
import sys
from pathlib import Path

app = Path(sys.argv[1]).resolve()

for entry in Path('/proc').iterdir():
    if not entry.name.isdigit():
        continue
    try:
        cwd = Path(os.readlink(entry / 'cwd')).resolve()
        argv = (entry / 'cmdline').read_bytes().split(b'\0')
        args = [
            part.decode('utf-8', 'replace')
            for part in argv
            if part
        ]
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        continue

    if cwd != app:
        continue

    joined = ' '.join(args)
    if 'electron' not in joined:
        continue
    if any(arg.startswith('--type=') for arg in args):
        continue

    print(entry.name)
    break
PY
}

cd "$ROOT" || fail "could not enter Floki-v2"
resolve_paths

PID=""
if [ -f "$PID_FILE" ]; then
  PID="$(tr -cd '0-9' < "$PID_FILE")"
fi

if ! electron_main_active "$PID"; then
  PID="$(discover_electron_main)"
fi

if ! electron_main_active "$PID"; then
  rm -f "$PID_FILE"
  echo "FLOKI_APP_STOP_PASS already_stopped=true"
  exit 0
fi

kill -TERM "$PID" >/dev/null 2>&1 || true

for _ in $(seq 1 40); do
  electron_main_active "$PID" || break
  sleep 0.25
done

if electron_main_active "$PID"; then
  kill -KILL "$PID" >/dev/null 2>&1 || true
  sleep 0.25
fi

electron_main_active "$PID" &&
  fail "Electron remained active after the stop request"

rm -f "$PID_FILE"
echo "FLOKI_APP_STOP_PASS pid=$PID shared_runtime_stopped=false"
