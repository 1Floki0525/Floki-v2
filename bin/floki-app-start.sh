#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/apps/floki-neural-interface"
RUNTIME_DIR=""
PID_FILE=""
LOG_FILE=""
NODE_RUN="$ROOT/bin/floki-node24-run.sh"

fail() {
  echo "FLOKI_APP_START_FAIL: $1" >&2
  exit 1
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
    if ! command -v node >/dev/null 2>&1 ||
       ! node -v 2>/dev/null | grep -Eq '^v(2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})\.'; then
      nvm use 24 >/dev/null 2>&1
    fi
  fi

  command -v node >/dev/null 2>&1 ||
    fail "Node was not found on PATH"

  case "$(node -v 2>/dev/null)" in
    v2[4-9].*|v[3-9][0-9].*|v[1-9][0-9][0-9]*.*) ;;
    *) fail "Node 24.x is required" ;;
  esac
}

resolve_paths_and_runtime() {
  mapfile -t VALUES < <(
    bash "$NODE_RUN" node - <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getLiveChatConfig,
  getPathConfig
} = require('./src/config/floki-config.cjs');

const live = getLiveChatConfig('chat');
const paths = getPathConfig('chat');
const runtimeDir = path.resolve(
  PROJECT_ROOT,
  paths.chat_runtime_root
);

process.stdout.write([
  runtimeDir,
  'http://' + live.runtime_host + ':' +
    String(live.runtime_port) + '/status',
  String(live.runtime_start_timeout_ms)
].join('\n'));
NODE
  ) || fail "could not resolve runtime settings from chat YAML"

  [ "${#VALUES[@]}" -eq 3 ] ||
    fail "runtime settings were incomplete"

  RUNTIME_DIR="${VALUES[0]}"
  STATUS_URL="${VALUES[1]}"
  START_TIMEOUT_MS="${VALUES[2]}"
  PID_FILE="$RUNTIME_DIR/floki-app.pid"
  LOG_FILE="$RUNTIME_DIR/floki-app.log"
  mkdir -p "$RUNTIME_DIR"
}

runtime_ready() {
  bash "$NODE_RUN" node - "$STATUS_URL" <<'NODE'
'use strict';
const url = process.argv[2];

fetch(url, {
  signal: AbortSignal.timeout(3000)
}).then((response) => {
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}).then((status) => {
  const ready =
    status.api_ready === true &&
    status.brain_loaded === true &&
    status.websocket_ready === true;
  process.exit(ready ? 0 : 1);
}).catch(() => process.exit(1));
NODE
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
load_node_24
resolve_paths_and_runtime

runtime_ready ||
  fail "the shared headless runtime is not ready; run floki-runtime-start"

EXISTING_PID=""
if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(tr -cd '0-9' < "$PID_FILE")"
fi

if ! electron_main_active "$EXISTING_PID"; then
  EXISTING_PID="$(discover_electron_main)"
fi

if electron_main_active "$EXISTING_PID"; then
  printf '%s\n' "$EXISTING_PID" > "$PID_FILE"
  echo "FLOKI_APP_START_PASS already_running=true pid=$EXISTING_PID"
  exit 0
fi

rm -f "$PID_FILE"

[ -d "$APP_DIR" ] ||
  fail "neural interface directory is missing"
[ -f "$APP_DIR/package.json" ] ||
  fail "neural interface package.json is missing"

if [ ! -x "$APP_DIR/node_modules/.bin/electron" ]; then
  bash "$NODE_RUN" npm --prefix "$APP_DIR" install \
    --no-audit --no-fund ||
    fail "neural interface dependency installation failed"
fi

if [ ! -f "$APP_DIR/dist/index.html" ] ||
   find "$APP_DIR/src" "$APP_DIR/electron" \
     -type f -newer "$APP_DIR/dist/index.html" \
     -print -quit | grep -q .
then
  bash "$NODE_RUN" npm --prefix "$APP_DIR" run build ||
    fail "neural interface build failed"
fi

cd "$APP_DIR" ||
  fail "could not enter neural interface directory"

setsid nohup env \
  FLOKI_ELECTRON_SHARED_RUNTIME_CLIENT=1 \
  ./node_modules/.bin/electron . \
  >>"$LOG_FILE" 2>&1 </dev/null &

APP_PID="$!"
printf '%s\n' "$APP_PID" > "$PID_FILE"
disown "$APP_PID" >/dev/null 2>&1 || true

for _ in $(seq 1 40); do
  if electron_main_active "$APP_PID"; then
    echo "FLOKI_APP_START_PASS pid=$APP_PID runtime_reused=true duplicate_runtime_started=false"
    exit 0
  fi
  sleep 0.25
done

tail -n 120 "$LOG_FILE" >&2 2>/dev/null || true
rm -f "$PID_FILE"
fail "Electron exited before the local app became active"
