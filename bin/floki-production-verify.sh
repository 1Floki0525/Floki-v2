#!/usr/bin/env bash
set -euo pipefail


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

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
NODE_RUN="$ROOT/bin/floki-node24-run.sh"
PY_CACHE="${TMPDIR:-/tmp}/floki-production-verify-pycache-$$"
cd "$ROOT"

fail() { echo "FLOKI_CHAT_LOCAL_PRODUCTION_VERIFY_FAIL: $1" >&2; exit 1; }
run_step() { local label="$1"; shift; echo; echo "=== $label ==="; "$@" || fail "$label"; }

[ -x "$NODE_RUN" ] || fail "Node 24 wrapper is missing or not executable"
NODE_VERSION="$("$NODE_RUN" node --version 2>/dev/null || true)"
if ! floki_node_24_or_newer "$NODE_VERSION"; then
  fail "Node 24 or newer is required; actual=${NODE_VERSION:-unavailable}"
fi

cleanup() { rm -rf "$PY_CACHE"; }
trap cleanup EXIT

run_step "Whitespace and patch integrity" git diff --check
run_step "Private chat YAML migration check" "$NODE_RUN" node bin/floki-migrate-chat-config.cjs --check
run_step "RSI YAML runtime authority" "$NODE_RUN" node tests/rsi-stage8-yaml-runtime-authority-contract-test.cjs
run_step "RSI Python syntax" env PYTHONPYCACHEPREFIX="$PY_CACHE" python3 -m py_compile \
  containers/self-improvement-training/train_qlora.py \
  containers/self-improvement-training/rem_inference.py
run_step "Training Python helper behavior" "$NODE_RUN" node tests/rsi-training-python-helper-contract-test.cjs
run_step "Training resource transaction behavior" "$NODE_RUN" node tests/rsi-training-runtime-resource-transaction-contract-test.cjs
run_step "Training resource compatibility behavior" "$NODE_RUN" node tests/rsi-training-runtime-resource-compatibility-contract-test.cjs
run_step "Manual training container cleanup" "$NODE_RUN" node tests/rsi-training-container-cleanup-contract-test.cjs
run_step "Nightly training launch cleanup" "$NODE_RUN" node tests/rsi-nightly-training-launch-cleanup-contract-test.cjs
run_step "HF REM container cleanup" "$NODE_RUN" node tests/rsi-hf-rem-container-cleanup-contract-test.cjs
run_step "Training failure REM continuity" "$NODE_RUN" node tests/rsi-nightly-training-failure-rem-continuity-contract-test.cjs
run_step "Adapter lineage error surfacing" "$NODE_RUN" node tests/rsi-adapter-lineage-error-surfacing-contract-test.cjs
run_step "Nightly finalization restart recovery" "$NODE_RUN" node tests/rsi-nightly-finalization-resume-contract-test.cjs
run_step "Stage 8 integration release gate" "$NODE_RUN" node tests/rsi-stage8-integration-release-gate-contract-test.cjs
run_step "Complete Node 24 contract suite" "$NODE_RUN" npm test
run_step "Root production build" "$NODE_RUN" npm run build
run_step "Neural-interface integration contracts" "$NODE_RUN" npm run test:integration --prefix apps/floki-neural-interface
run_step "Neural-interface production build" "$NODE_RUN" npm run build --prefix apps/floki-neural-interface

echo
echo "FLOKI_CHAT_LOCAL_PRODUCTION_STATIC_VERIFY_PASS"
echo "FLOKI_RSI_STAGE8_PRODUCTION_VERIFY_PASS"
echo "Next live commands: bin/floki-runtime.sh reset ; bin/floki-app.sh"
echo "Do not merge until manual training, abort, restoration, cognition recovery, manual nap, and nighttime REM pass."
