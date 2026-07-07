#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_RUN="$PROJECT_DIR/bin/floki-node24-run.sh"
SERVICE="$PROJECT_DIR/src/vision/chat-webcam-vision-service.cjs"

cd "$PROJECT_DIR"
[ -x "$NODE_RUN" ] || { echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: Node 24 runner missing: $NODE_RUN" >&2; exit 1; }
[ -f "$SERVICE" ] || { echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: webcam service missing: $SERVICE" >&2; exit 1; }

bash "$NODE_RUN" node "$SERVICE" --stop
