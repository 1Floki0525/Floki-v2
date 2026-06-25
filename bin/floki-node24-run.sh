#!/usr/bin/env bash

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FLOKI_V2_NODE24_FAIL: $1" >&2
  exit 1
}

node_is_24() {
  command -v node >/dev/null 2>&1 || return 1

  case "$(node -v 2>/dev/null)" in
    v24.*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

activate_node24_with_nvm() {
  nvm_script=""

  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    nvm_script="$NVM_DIR/nvm.sh"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    nvm_script="$NVM_DIR/nvm.sh"
  fi

  if [ -z "$nvm_script" ]; then
    return 1
  fi

  . "$nvm_script" || fail "could not load nvm from $nvm_script"
  nvm use 24.17.0 >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1 || fail "nvm could not activate Node v24.17.0"
}

if ! node_is_24; then
  activate_node24_with_nvm || true
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node was not found"
fi

NODE_VERSION="$(node -v 2>/dev/null)"
case "$NODE_VERSION" in
  v24.17.0)
    ;;
  *)
    fail "Floki-v2 requires Node v24.17.0 exclusively; active version is $NODE_VERSION"
    ;;
esac

cd "$PROJECT_DIR" || fail "could not enter $PROJECT_DIR"

if [ "$#" -eq 0 ]; then
  echo "FLOKI_V2_NODE24_PASS: $NODE_VERSION"
  exit 0
fi

exec "$@"
