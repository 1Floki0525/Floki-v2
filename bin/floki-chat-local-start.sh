#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$PROJECT_DIR/apps/floki-neural-interface"

fail() {
  echo "FLOKI_V2_CHAT_LOCAL_START_FAIL: $1" >&2
  exit 1
}

cd "$PROJECT_DIR" || fail "could not enter project directory"

[ -d "$APP_DIR" ] || fail "interface directory missing: $APP_DIR"
[ -f "$APP_DIR/package.json" ] || fail "interface package.json missing"

echo "[FLOKI STARTUP 6/7] Preparing and validating the React neural interface"

if [ ! -d "$APP_DIR/node_modules" ]; then
  (cd "$APP_DIR" && npm install --no-audit --no-fund) || fail "interface dependency installation failed"
fi

if [ ! -f "$APP_DIR/dist/index.html" ] || find "$APP_DIR/src" "$APP_DIR/electron" -type f -newer "$APP_DIR/dist/index.html" -print -quit | grep -q .; then
  (cd "$APP_DIR" && npm run build) || fail "interface build failed"
fi

(cd "$APP_DIR" && npm run test:integration) || fail "interface contract failed"

cd "$APP_DIR" || fail "could not enter interface directory"
echo "[FLOKI STARTUP 7/7] Connecting the neural interface to the authoritative live runtime"
exec ./node_modules/.bin/electron .
