#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/bin/floki-node24-run.sh" node - <<'NODE'
const {
  readStatus,
  listCandidates
} = require('./src/self-improvement/store.cjs');

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_STATUS_PASS',
  status: readStatus(),
  candidates: listCandidates()
}, null, 2));
NODE
