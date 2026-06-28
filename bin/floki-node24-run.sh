#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"

fail() {
  echo "FLOKI_V2_NODE24_FAIL: $1" >&2
  exit 1
}

node_is_24() {
  command -v node >/dev/null 2>&1 || return 1
  case "$(node -v 2>/dev/null)" in
    v24.*) return 0 ;;
    *) return 1 ;;
  esac
}

activate_node24_with_nvm() {
  local nvm_script=""

  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    nvm_script="$NVM_DIR/nvm.sh"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    nvm_script="$NVM_DIR/nvm.sh"
  fi

  [ -n "$nvm_script" ] || return 1
  # shellcheck disable=SC1090
  . "$nvm_script" || fail "could not load nvm from $nvm_script"
  nvm use 24 >/dev/null 2>&1 || return 1
}

# Preserve an already-active Node 24.x exactly as selected by the user's shell.
# Only use NVM when the active node is missing or outside major version 24.
if ! node_is_24; then
  activate_node24_with_nvm || true
fi

if ! node_is_24; then
  fail "Floki-v2 requires Node 24.x; active version is $(node -v 2>/dev/null || echo unavailable)"
fi

NODE_VERSION="$(node -v)"
cd -- "$PROJECT_DIR" || fail "could not enter $PROJECT_DIR"

if [ "$#" -eq 0 ]; then
  echo "FLOKI_V2_NODE24_PASS: $NODE_VERSION"
  exit 0
fi

exec "$@"
