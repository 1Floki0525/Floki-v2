#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"

fail() {
  printf 'FLOKI_DESKTOP_WIDGET_START_ERROR: %s\n' "$1" >&2
  exit 1
}

[ -x "$NODE_RUN" ] || fail "Node 24 runner is missing: $NODE_RUN"
cd "$ROOT"

if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_SKIP" "reason=no_graphical_desktop"
  exit 0
fi

mapfile -t VALUES < <(
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const path = require('node:path');
const {
  PROJECT_ROOT,
  getLiveChatConfig,
  getPathConfig
} = require('./src/config/floki-config.cjs');
const live = getLiveChatConfig('chat');
const paths = getPathConfig('chat');
process.stdout.write([
  path.resolve(PROJECT_ROOT, paths.chat_runtime_root),
  'http://' + live.runtime_host + ':' + String(live.runtime_port) + '/status',
  String(live.runtime_start_timeout_ms)
].join('\n'));
NODE
) || fail "could not resolve runtime/widget settings from YAML"

[ "${#VALUES[@]}" -eq 3 ] || fail "runtime/widget settings were incomplete"

RUNTIME_ROOT="${VALUES[0]}"
STATUS_URL="${VALUES[1]}"
START_TIMEOUT_MS="${VALUES[2]}"
APP_DIR="$ROOT/apps/floki-neural-interface"
DIST_INDEX="$APP_DIR/dist/index.html"
ELECTRON_BIN="$APP_DIR/node_modules/.bin/electron"
PID_FILE="$RUNTIME_ROOT/floki-desktop-widget.pid"
READY_FILE="$RUNTIME_ROOT/floki-desktop-widget.ready.json"
LOG_FILE="$RUNTIME_ROOT/floki-desktop-widget.log"
mkdir -p "$RUNTIME_ROOT"

runtime_ready() {
  bash "$NODE_RUN" node - "$STATUS_URL" <<'NODE' >/dev/null 2>&1
'use strict';
fetch(process.argv[2], { signal: AbortSignal.timeout(5000) })
  .then((response) => {
    if (!response.ok) throw new Error('runtime HTTP failure');
    return response.json();
  })
  .then((status) => {
    if (status.api_ready !== true || status.brain_loaded !== true) throw new Error('runtime not ready');
  })
  .catch(() => process.exit(1));
NODE
}

if [ "${FLOKI_COMMANDS_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' \
    "FLOKI_DESKTOP_SIDE_WIDGET_DRY_RUN" \
    "runtime_autostart=false" \
    "detached=true" \
    "right_edge_widget=true"
  exit 0
fi

runtime_ready || fail "shared runtime is not running; run floki-runtime.sh start first"

if [ ! -f "$DIST_INDEX" ]; then
  bash "$NODE_RUN" npm --prefix "$APP_DIR" run build || fail "could not build neural interface for desktop widget"
fi

[ -x "$ELECTRON_BIN" ] || fail "Electron binary is missing: $ELECTRON_BIN"

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(tr -cd '0-9' < "$PID_FILE" || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" >/dev/null 2>&1; then
    printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_ALREADY_RUNNING" "pid=$EXISTING_PID" "ready_file=$READY_FILE"
    exit 0
  fi
  rm -f "$PID_FILE" "$READY_FILE"
fi

command -v setsid >/dev/null 2>&1 || fail "setsid is required"

printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_STARTING" "runtime=$STATUS_URL" "log=$LOG_FILE"

FLOKI_DESKTOP_WIDGET_PID_FILE="$PID_FILE" \
FLOKI_DESKTOP_WIDGET_READY_FILE="$READY_FILE" \
setsid bash -c '
  set -Eeuo pipefail
  cd "$1"
  exec "$2" electron/widget.cjs
' floki-desktop-widget "$APP_DIR" "$ELECTRON_BIN" </dev/null >>"$LOG_FILE" 2>&1 &
SUPERVISOR_PID="$!"

if ! bash "$NODE_RUN" node - "$SUPERVISOR_PID" "$PID_FILE" "$READY_FILE" "$LOG_FILE" "$START_TIMEOUT_MS" <<'NODE'
'use strict';
const fs = require('node:fs');
const [supervisorRaw, pidFile, readyFile, logFile, timeoutRaw] = process.argv.slice(2);
const supervisorPid = Number(supervisorRaw);
const timeoutMs = Number(timeoutRaw);
const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (_error) { return false; }
}
(async () => {
  while (Date.now() <= deadline) {
    let ready = null;
    try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (_error) {}
    if (ready && ready.marker === 'FLOKI_DESKTOP_SIDE_WIDGET_READY' && alive(ready.pid)) {
      const recorded = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
      if (recorded !== Number(ready.pid)) throw new Error('desktop widget PID file mismatch');
      process.stdout.write(JSON.stringify(ready));
      return;
    }
    if (!alive(supervisorPid)) {
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').slice(-4000); } catch (_error) {}
      throw new Error('desktop widget exited before readiness\n' + tail);
    }
    await sleep(120);
  }
  throw new Error('desktop widget did not become ready within ' + timeoutMs + ' ms');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
then
  kill "$SUPERVISOR_PID" >/dev/null 2>&1 || true
  fail "desktop widget failed to become ready; see $LOG_FILE"
fi

printf '\n'
printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_START_PASS" "pid=$(tr -cd '0-9' < "$PID_FILE")" "log=$LOG_FILE" "detached=true"
