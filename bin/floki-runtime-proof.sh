#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FLOKI_V2_RUNTIME_PROOF_FAIL: $1" >&2
  exit 1
}

if [ ! -d "$PROJECT_DIR" ]; then
  fail "Project directory not found: $PROJECT_DIR"
fi

cd "$PROJECT_DIR" || fail "Could not cd into $PROJECT_DIR"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"

  if [ -f "$PROJECT_DIR/.nvmrc" ]; then
    nvm use >/dev/null 2>&1
  else
    nvm use 24 >/dev/null 2>&1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found on PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm was not found on PATH"
fi

if ! command -v java >/dev/null 2>&1; then
  fail "java was not found on PATH"
fi

NODE_VERSION="$(node -v 2>/dev/null)"
NODE_STATUS="$?"

if [ "$NODE_STATUS" -ne 0 ]; then
  fail "node -v failed"
fi

NPM_VERSION="$(npm -v 2>/dev/null)"
NPM_STATUS="$?"

if [ "$NPM_STATUS" -ne 0 ]; then
  fail "npm -v failed"
fi

JAVA_VERSION_RAW="$(java -version 2>&1)"
JAVA_STATUS="$?"

if [ "$JAVA_STATUS" -ne 0 ]; then
  fail "java -version failed"
fi

node src/config/runtime-cli.cjs validate-node "$NODE_VERSION" >/dev/null
NODE_CHECK_STATUS="$?"

if [ "$NODE_CHECK_STATUS" -ne 0 ]; then
  fail "Node runtime policy check failed for $NODE_VERSION"
fi

node src/config/runtime-cli.cjs validate-java "$JAVA_VERSION_RAW" >/dev/null
JAVA_CHECK_STATUS="$?"

if [ "$JAVA_CHECK_STATUS" -ne 0 ]; then
  fail "Java runtime policy check failed"
fi

node tests/foundation-contract-test.cjs >/dev/null
FOUNDATION_STATUS="$?"

if [ "$FOUNDATION_STATUS" -ne 0 ]; then
  fail "Foundation contract test failed"
fi

node -e "const runtime = require('./src/config/runtime-config.cjs'); console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_RUNTIME_POLICY_PASS', node_version: process.version, npm_version: '$NPM_VERSION', java_major_required: runtime.RUNTIME_CONFIG.java.minimum_major, future_papermc_target: runtime.RUNTIME_CONFIG.papermc.future_target_server_version, papermc_enabled_now: runtime.RUNTIME_CONFIG.papermc.enabled_in_current_stage, bridge_enabled_now: runtime.RUNTIME_CONFIG.papermc.wire_bridge_in_current_stage, body_movement_enabled_now: false }, null, 2));"
