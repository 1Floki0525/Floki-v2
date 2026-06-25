#!/usr/bin/env bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE24_RUN="$ROOT/bin/floki-node24-run.sh"

fail() {
  echo "FLOKI_CHAT_LOCAL_TEST_FAIL: $1" >&2
  exit 1
}

cd "$ROOT" || fail "cannot enter project root"
[ -x "$NODE24_RUN" ] || fail "Node 24 runner is missing or not executable"

"$NODE24_RUN" node tests/run-chat-local-suite.cjs
STATUS="$?"
[ "$STATUS" -eq 0 ] || fail "chat.local suite failed with status $STATUS"

echo "FLOKI_CHAT_LOCAL_TEST_PASS"
