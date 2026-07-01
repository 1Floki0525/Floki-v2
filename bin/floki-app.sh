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
  'http://' + live.runtime_host + ':' + String(live.runtime_port) + '/status'
].join('\n'));
NODE
) || fail "could not resolve app/runtime settings from YAML"

[ "${#APP_VALUES[@]}" -eq 2 ] || fail "app/runtime settings were incomplete"
RUNTIME_ROOT="${APP_VALUES[0]}"
STATUS_URL="${APP_VALUES[1]}"
APP_PID_FILE="$RUNTIME_ROOT/floki-app.pid"
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
  printf '%s\n' "FLOKI_APP_DRY_RUN" "runtime_autostart=false" "launcher=bin/floki-chat-local-start.sh" "process_name=floki.app"
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

command -v setsid >/dev/null 2>&1 || fail "setsid is required"

cleanup() {
  rm -f "$APP_PID_FILE"
  printf '\033]0;\007'
}
trap cleanup EXIT INT TERM HUP

printf '\033]0;floki.app\007'
printf '%s\n' "FLOKI_APP_START" "runtime_autostart=false" "shared_runtime=$STATUS_URL"

setsid bash "$ROOT/bin/floki-chat-local-start.sh" "$@" &
APP_PID="$!"
printf '%s\n' "$APP_PID" > "$APP_PID_FILE"
wait "$APP_PID"
STATUS="$?"
printf '%s\n' "FLOKI_APP_EXIT" "status=$STATUS"
exit "$STATUS"
