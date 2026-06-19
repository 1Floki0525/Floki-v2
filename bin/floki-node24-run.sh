#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FLOKI_V2_NODE24_FAIL: $1" >&2
  exit 1
}

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1 || fail "nvm could not activate Node 24"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found after attempting to activate Node 24"
fi

NODE_VERSION="$(node -v 2>/dev/null)"
case "$NODE_VERSION" in
  v24.*)
    ;;
  *)
    fail "Floki-v2 requires Node 24 exclusively; active version is $NODE_VERSION"
    ;;
esac

cd "$PROJECT_DIR" || fail "could not enter $PROJECT_DIR"

if [ "$#" -eq 0 ]; then
  echo "FLOKI_V2_NODE24_PASS: $NODE_VERSION"
  exit 0
fi

exec "$@"
