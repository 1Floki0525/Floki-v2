#!/usr/bin/env bash


floki_node_24_or_newer() {
  local floki_node_version="${1:-}"
  local floki_node_major
  if [ -z "$floki_node_version" ]; then
    command -v node >/dev/null 2>&1 || return 1
    floki_node_version="$(node -v 2>/dev/null)" || return 1
  fi
  floki_node_version="${floki_node_version#v}"
  floki_node_major="${floki_node_version%%.*}"
  case "$floki_node_major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$floki_node_major" -ge 24 ]
}

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR" || exit 1

source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! floki_node_24_or_newer; then
  nvm use 24 >/dev/null
fi
NODE_VERSION="$(node -v)"
if ! floki_node_24_or_newer "$NODE_VERSION"; then
  echo "FLOKI_V2_CHAT_WEBCAM_SERVICE_FAIL: Node 24 or newer required, got $NODE_VERSION" >&2; exit 1
fi

node src/vision/chat-webcam-vision-service.cjs --status
