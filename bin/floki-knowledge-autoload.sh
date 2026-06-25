#!/usr/bin/env bash
set -uo pipefail

fail_json() {
  printf '%s\n' "{\"ok\":false,\"marker\":\"FLOKI_V2_KNOWLEDGE_AUTOLOAD_FAIL\",\"error\":\"$1\",\"chat_mode_only\":true,\"game_mode_started\":false}"
  exit 1
}

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || fail_json "could not enter project root"

NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
case "$NODE_VERSION" in
  24.*) ;;
  *) fail_json "Node 24 required, got ${NODE_VERSION:-unavailable}" ;;
esac

node <<'NODE'
'use strict';

const { getPathConfig } = require('./src/config/floki-config.cjs');
const { runConfiguredKnowledgeAutoload } = require('./src/chat/knowledge-autoload.cjs');

try {
  const paths = getPathConfig('chat');
  const result = runConfiguredKnowledgeAutoload({
    text_root: paths.text_root,
    force: process.env.FLOKI_KNOWLEDGE_AUTOLOAD_FORCE === '1'
  });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result || result.ok !== true) process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_FAIL',
    error: error && error.message ? error.message : String(error),
    chat_mode_only: true,
    game_mode_started: false
  }) + '\n');
  process.exitCode = 1;
}
NODE
