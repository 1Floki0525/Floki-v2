#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
nvm use 24 >/dev/null
NODE_VERSION="$(node -v)"
case "$NODE_VERSION" in
  v24.*) ;;
  *) echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: Node 24 required, got $NODE_VERSION" >&2; exit 1 ;;
esac

node src/vision/chat-webcam-vision-service.cjs --status
