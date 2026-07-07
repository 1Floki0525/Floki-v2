#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"

fail() {
  printf 'FLOKI_APP_COMMAND_ERROR: %s\n' "$1" >&2
  exit 1
}

[ -x "$NODE_RUN" ] || fail "Node 24 runner is missing: $NODE_RUN"
[ -x "$ROOT/bin/floki-chat-local-start.sh" ] || fail "local Electron launcher is missing"
cd "$ROOT"

mapfile -t APP_VALUES < <(
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
) || fail "could not resolve app/runtime settings from YAML"

[ "${#APP_VALUES[@]}" -eq 3 ] || fail "app/runtime settings were incomplete"
RUNTIME_ROOT="${APP_VALUES[0]}"
STATUS_URL="${APP_VALUES[1]}"
APP_START_TIMEOUT_MS="${APP_VALUES[2]}"
APP_PID_FILE="$RUNTIME_ROOT/floki-app.pid"
APP_READY_FILE="$RUNTIME_ROOT/floki-app.ready.json"
APP_LOG_FILE="$RUNTIME_ROOT/floki-app.log"
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
    if (status.api_ready !== true || status.brain_loaded !== true) {
      throw new Error('runtime not ready');
    }
  })
  .catch(() => process.exit(1));
NODE
}

if [ "${FLOKI_COMMANDS_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n'     "FLOKI_APP_DRY_RUN"     "runtime_autostart=false"     "launcher=bin/floki-chat-local-start.sh"     "process_name=floki.app"     "detached=true"     "terminal_released=true"
  exit 0
fi

runtime_ready || fail "shared runtime is not running; run floki-runtime.sh start first"

if [ -f "$APP_PID_FILE" ]; then
  EXISTING_PID="$(tr -cd '0-9' < "$APP_PID_FILE")"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" >/dev/null 2>&1; then
    fail "floki.app is already running with PID $EXISTING_PID"
  fi
  rm -f "$APP_PID_FILE"
fi
rm -f "$APP_READY_FILE"

command -v setsid >/dev/null 2>&1 || fail "setsid is required"

printf '\033]0;floki.app\007'
printf '%s\n' "FLOKI_APP_START" "runtime_autostart=false" "shared_runtime=$STATUS_URL"

FLOKI_APP_PID_FILE="$APP_PID_FILE" FLOKI_APP_READY_FILE="$APP_READY_FILE" setsid bash -c '
  set -uo pipefail
  pid_file="$1"
  ready_file="$2"
  launcher="$3"
  shift 3
  cleanup() {
    current=""
    if [ -f "$pid_file" ]; then current="$(tr -cd "0-9" < "$pid_file")"; fi
    if [ -z "$current" ] || [ "$current" = "$$" ]; then rm -f "$pid_file" "$ready_file"; fi
  }
  trap cleanup EXIT INT TERM HUP
  printf "%s\n" "$$" > "$pid_file"
  bash "$launcher" "$@"
' floki-app-supervisor "$APP_PID_FILE" "$APP_READY_FILE"   "$ROOT/bin/floki-chat-local-start.sh" "$@"   </dev/null >>"$APP_LOG_FILE" 2>&1 &
APP_PID="$!"

if ! bash "$NODE_RUN" node -   "$APP_PID" "$APP_PID_FILE" "$APP_READY_FILE" "$APP_LOG_FILE"   "$APP_START_TIMEOUT_MS" <<'NODE'
'use strict';
const fs = require('node:fs');
const [pidRaw, pidFile, readyFile, logFile, timeoutRaw] = process.argv.slice(2);
const pid = Number(pidRaw);
const timeoutMs = Number(timeoutRaw);
const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(value) {
  try { process.kill(Number(value), 0); return true; } catch (_error) { return false; }
}
(async () => {
  while (Date.now() <= deadline) {
    if (!alive(pid)) {
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').slice(-4000); } catch (_error) {}
      throw new Error('detached floki.app supervisor exited before window readiness\n' + tail);
    }
    let ready = null;
    try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (_error) {}
    if (
      ready &&
      ready.marker === 'FLOKI_V2_ELECTRON_WINDOW_READY' &&
      Number.isInteger(Number(ready.pid)) &&
      alive(Number(ready.pid))
    ) {
      const recorded = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
      if (recorded !== pid) throw new Error('floki.app supervisor PID file mismatch');
      process.stdout.write(JSON.stringify(ready));
      return;
    }
    await sleep(100);
  }
  throw new Error('floki.app window did not become ready within ' + timeoutMs + ' ms');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
NODE
then
  kill -- "-$APP_PID" >/dev/null 2>&1 || kill "$APP_PID" >/dev/null 2>&1 || true
  fail "floki.app failed to reach visible window readiness; see $APP_LOG_FILE"
fi

printf '\033]0;\007'
printf '%s\n'   "FLOKI_APP_READY"   "pid=$APP_PID"   "log=$APP_LOG_FILE"   "detached=true"   "terminal_released=true"
exit 0
