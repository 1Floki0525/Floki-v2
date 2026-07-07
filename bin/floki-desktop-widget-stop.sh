#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"

fail() {
  printf 'FLOKI_DESKTOP_WIDGET_STOP_ERROR: %s\n' "$1" >&2
  exit 1
}

[ -x "$NODE_RUN" ] || fail "Node 24 runner is missing: $NODE_RUN"
cd "$ROOT"

mapfile -t VALUES < <(
  bash "$NODE_RUN" node <<'NODE'
'use strict';
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./src/config/floki-config.cjs');
const paths = getPathConfig('chat');
process.stdout.write(path.resolve(PROJECT_ROOT, paths.chat_runtime_root));
NODE
) || fail "could not resolve runtime path from YAML"

RUNTIME_ROOT="${VALUES[0]}"
PID_FILE="$RUNTIME_ROOT/floki-desktop-widget.pid"
READY_FILE="$RUNTIME_ROOT/floki-desktop-widget.ready.json"

if [ ! -f "$PID_FILE" ]; then
  rm -f "$READY_FILE"
  printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_ALREADY_STOPPED"
  exit 0
fi

PID="$(tr -cd '0-9' < "$PID_FILE" || true)"
if [ -z "$PID" ] || ! kill -0 "$PID" >/dev/null 2>&1; then
  rm -f "$PID_FILE" "$READY_FILE"
  printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_ALREADY_STOPPED"
  exit 0
fi

kill "$PID" >/dev/null 2>&1 || true
deadline=$((SECONDS + 10))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    rm -f "$PID_FILE" "$READY_FILE"
    printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_STOP_PASS" "pid=$PID"
    exit 0
  fi
  sleep 0.25
done

kill -9 "$PID" >/dev/null 2>&1 || true
rm -f "$PID_FILE" "$READY_FILE"
printf '%s\n' "FLOKI_DESKTOP_SIDE_WIDGET_STOP_PASS" "pid=$PID" "forced=true"
