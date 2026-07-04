#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"

# Compatibility-only internal entrypoint. It owns no lifecycle logic.
# Every complete Floki shutdown is delegated to the sole runtime authority.
printf '%s\n' \
  "FLOKI_CHAT_LOCAL_CLEANUP_DELEGATED" \
  "runtime_authority=bin/floki-runtime.sh" \
  "action=stop"

exec bash "$ROOT/bin/floki-runtime.sh" stop
