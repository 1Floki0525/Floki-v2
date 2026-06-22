#!/usr/bin/env bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE24_RUN="$ROOT/bin/floki-node24-run.sh"
APP_DIR="$ROOT/apps/floki-neural-interface"

fail() {
  echo "FLOKI_V2_BUILD_FAIL: $1" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "required file is missing: $1"
}

require_file "$NODE24_RUN"
require_file "$ROOT/package.json"
require_file "$ROOT/package-lock.json"
require_file "$ROOT/.nvmrc"
require_file "$APP_DIR/package.json"
require_file "$APP_DIR/package-lock.json"
require_file "$APP_DIR/tests/chat-local-contract.cjs"
require_file "$APP_DIR/tests/full-interface-preservation-contract.cjs"

[ -x "$NODE24_RUN" ] || fail "Node 24 runner is not executable: $NODE24_RUN"
[ -d "$APP_DIR/node_modules" ] || fail "neural-interface dependencies are missing; run npm --prefix apps/floki-neural-interface ci"
[ -x "$APP_DIR/node_modules/.bin/vite" ] || fail "Vite is missing from neural-interface dependencies; run npm --prefix apps/floki-neural-interface ci"

"$NODE24_RUN" || fail "Node 24 validation failed"
"$NODE24_RUN" node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); JSON.parse(require('node:fs').readFileSync('apps/floki-neural-interface/package.json','utf8'));" || fail "package configuration validation failed"

"$NODE24_RUN" npm --prefix "$APP_DIR" run build
BUILD_STATUS="$?"
[ "$BUILD_STATUS" -eq 0 ] || fail "neural-interface Vite build failed with status $BUILD_STATUS"

"$NODE24_RUN" npm --prefix "$APP_DIR" run test:integration
TEST_STATUS="$?"
[ "$TEST_STATUS" -eq 0 ] || fail "neural-interface integration tests failed with status $TEST_STATUS"

echo "FLOKI_V2_BUILD_PASS"
