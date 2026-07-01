#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"

fail() {
  echo "FLOKI_V2_NODE24_FAIL: $1" >&2
  exit 1
}

node_is_24_or_newer() {
  command -v node >/dev/null 2>&1 || return 1
  local version major
  version="$(node -v 2>/dev/null)" || return 1
  version="${version#v}"
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -ge 24 ]
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

# Preserve an already-active Node 24 or newer exactly as selected by the user's shell.
# Only use NVM when the active node is missing or older than major version 24.
if ! node_is_24_or_newer; then
  activate_node24_with_nvm || true
fi

if ! node_is_24_or_newer; then
  fail "Floki-v2 requires Node 24 or newer; active version is $(node -v 2>/dev/null || echo unavailable)"
fi

NODE_VERSION="$(node -v)"
cd -- "$PROJECT_DIR" || fail "could not enter $PROJECT_DIR"

if [ "$#" -eq 0 ]; then
  echo "FLOKI_V2_NODE24_PASS: $NODE_VERSION"
  exit 0
fi

exec "$@"
