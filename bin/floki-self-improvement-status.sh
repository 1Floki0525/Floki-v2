#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash "$ROOT/bin/floki-node24-run.sh" node - <<'NODE'
'use strict';

const fs = require('node:fs');
const { loadSelfImprovementConfig } = require('./src/self-improvement/config.cjs');
const {
  ensureLayout,
  readStatus,
  listCandidates
} = require('./src/self-improvement/store.cjs');

function readPidFile(file) {
  try {
    const raw = String(fs.readFileSync(file, 'utf8')).trim();
    const pid = Number(raw.replace(/[^0-9]/g, ''));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

function workerActive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (_error) {
    return false;
  }
  try {
    const cmdline = fs.readFileSync('/proc/' + String(pid) + '/cmdline')
      .toString('utf8')
      .replace(/\0/g, ' ');
    return cmdline.includes('src/self-improvement/worker.cjs');
  } catch (_error) {
    return false;
  }
}

const config = loadSelfImprovementConfig();
const paths = ensureLayout(config);
const status = readStatus(config);
const pidFromFile = readPidFile(paths.pidFile);
const pidFromStatus = Number(status.worker_pid);
const candidatePids = [
  pidFromFile,
  Number.isInteger(pidFromStatus) && pidFromStatus > 0 ? pidFromStatus : null
].filter(Boolean);

let activePid = null;
for (const pid of candidatePids) {
  if (workerActive(pid)) {
    activePid = pid;
    break;
  }
}

const active = Number.isInteger(activePid) && activePid > 0;
const normalizedStatus = Object.freeze({
  ...status,
  worker_running: active,
  worker_pid: active ? activePid : null,
  model_proxy_ready: active ? status.model_proxy_ready === true : false
});

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_STATUS_PASS',
  active,
  pid: activePid,
  service_state: active
    ? (normalizedStatus.paused === true ? 'paused' : 'running')
    : 'stopped',
  paused: normalizedStatus.paused === true,
  status: normalizedStatus,
  candidates: listCandidates(config)
}, null, 2));
NODE
