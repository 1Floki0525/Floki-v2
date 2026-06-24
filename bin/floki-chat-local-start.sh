#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$PROJECT_DIR/apps/floki-neural-interface"

fail() {
  echo "FLOKI_V2_CHAT_LOCAL_START_FAIL: $1" >&2
  exit 1
}

load_node_24() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$HOME/.nvm/nvm.sh"
    nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "node was not found on PATH"
  fi

  NODE_VERSION="$(node -v 2>/dev/null)"
  case "$NODE_VERSION" in
    v24.17.0)
      ;;
    *)
      fail "Node v24.17.0 required, got $NODE_VERSION"
      ;;
  esac
}

verify_runtime_connection() {
  local status_url
  status_url="$(node - <<'NODE'
'use strict';
const { getLiveChatConfig } = require('./src/config/floki-config.cjs');
const c = getLiveChatConfig('chat');
console.log(JSON.stringify({ url: 'http://' + c.runtime_host + ':' + String(c.runtime_port) + '/status', timeout_ms: c.runtime_start_timeout_ms }));
NODE
)" || fail "could not read runtime connection settings from YAML"

  node - "$status_url" <<'NODE'
'use strict';
const config = JSON.parse(process.argv[2]);
fetch(config.url, { signal: AbortSignal.timeout(config.timeout_ms) })
  .then((response) => {
    if (!response.ok) {
      throw new Error('runtime returned HTTP ' + response.status);
    }
    return response.json();
  })
  .then((payload) => {
    if (payload.api_ready !== true || payload.brain_loaded !== true) {
      throw new Error('runtime is not api_ready/brain_loaded');
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('FLOKI_V2_CHAT_LOCAL_RUNTIME_CONNECTION_FAIL: ' + (error && error.message ? error.message : String(error)));
    process.exit(1);
  });
NODE
}

cd "$PROJECT_DIR" || fail "could not enter project directory"
load_node_24

[ -d "$APP_DIR" ] || fail "interface directory missing: $APP_DIR"
[ -f "$APP_DIR/package.json" ] || fail "interface package.json missing"

echo "[FLOKI STARTUP 6/7] Preparing the React neural interface while camera and microphone remain off"

if [ ! -d "$APP_DIR/node_modules" ]; then
  (cd "$APP_DIR" && npm install --no-audit --no-fund) || fail "interface dependency installation failed"
fi

if [ ! -f "$APP_DIR/dist/index.html" ] || find "$APP_DIR/src" "$APP_DIR/electron" -type f -newer "$APP_DIR/dist/index.html" -print -quit | grep -q .; then
  (cd "$APP_DIR" && npm run build) || fail "interface build failed"
fi

INTEGRATION_OUTPUT="$(mktemp /tmp/floki-interface-integration.XXXXXX)"
if ! (cd "$APP_DIR" && npm run test:integration) > "$INTEGRATION_OUTPUT" 2>&1; then
  cat "$INTEGRATION_OUTPUT" >&2
  rm -f "$INTEGRATION_OUTPUT"
  fail "interface integration tests failed"
fi
rm -f "$INTEGRATION_OUTPUT"

verify_runtime_connection || fail "authoritative chat.local runtime is not reachable before launching the interface"

cd "$APP_DIR" || fail "could not enter interface directory"
bash "$PROJECT_DIR/bin/floki-self-improvement-start.sh" || fail "recursive self-improvement worker did not start"

echo "[FLOKI STARTUP 7/7] Opening the neural interface for the authoritative live runtime; the visible window will release awake eyes and ears"
exec ./node_modules/.bin/electron .
