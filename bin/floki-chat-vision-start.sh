#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$PROJECT_DIR/bin/floki-node24-run.sh"
SERVICE="$PROJECT_DIR/src/vision/chat-webcam-vision-service.cjs"
CLEANUP="$PROJECT_DIR/bin/floki-chat-local-cleanup.sh"

fail() {
  echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: $1" >&2
  exit 1
}

handle_interrupt() {
  trap - INT TERM HUP
  timeout 25s bash "$CLEANUP" >/dev/null 2>&1 || true
  echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_INTERRUPTED" >&2
  exit 130
}

cd "$PROJECT_DIR" || fail "could not enter project directory"
[ -x "$NODE_RUN" ] || fail "Node 24 runner missing: $NODE_RUN"
[ -x "$CLEANUP" ] || fail "chat.local cleanup missing: $CLEANUP"
[ -f "$SERVICE" ] || fail "webcam service missing: $SERVICE"

trap handle_interrupt INT TERM HUP

FLOKI_ALLOW_WEBCAM_CAPTURE=1 \
FLOKI_ALLOW_CHAT_VISION=1 \
timeout --signal=TERM --kill-after=5s 45s \
  bash "$NODE_RUN" node "$SERVICE" --start
STATUS="$?"

trap - INT TERM HUP

if [ "$STATUS" -ne 0 ]; then
  timeout 25s bash "$CLEANUP" >/dev/null 2>&1 || true
  fail "webcam service start failed or exceeded 45 seconds (status $STATUS)"
fi

exit 0
