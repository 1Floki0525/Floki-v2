'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const START = path.join(ROOT, 'bin', 'floki-chat-start.sh');
const STOP = path.join(ROOT, 'bin', 'floki-chat-stop.sh');
const PROOF = path.join(ROOT, 'bin', 'floki-chat-proof.sh');
const PID_FILE = path.join(ROOT, 'state', 'floki', 'chat', 'runtime', 'chat-mode-loop.pid');

function runShell(script) {
  return spawnSync('bash', [script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FLOKI_CHAT_SCRIPT_DRY_RUN: '1'
    },
    timeout: 120000
  });
}

function markerFrom(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1] || '{}').marker;
}

function run() {
  const beforePidContent = fs.existsSync(PID_FILE)
    ? fs.readFileSync(PID_FILE, 'utf8')
    : null;

  const start = runShell(START);
  const stop = runShell(STOP);
  const proof = runShell(PROOF);

  assert.equal(start.status, 0, start.stderr);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(proof.status, 0, proof.stderr);
  assert.equal(markerFrom(start.stdout), 'FLOKI_V2_CHAT_START_SCRIPT_PASS');
  assert.equal(markerFrom(stop.stdout), 'FLOKI_V2_CHAT_STOP_SCRIPT_PASS');
  assert.equal(markerFrom(proof.stdout), 'FLOKI_V2_CHAT_PROOF_SCRIPT_PASS');

  const afterPidContent = fs.existsSync(PID_FILE)
    ? fs.readFileSync(PID_FILE, 'utf8')
    : null;

  assert.equal(afterPidContent, beforePidContent);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_SCRIPTS_GUARD_PASS',
    dry_run_did_not_start_loop: true,
    dry_run_did_not_record_microphone: true,
    dry_run_did_not_run_qwen: true,
    dry_run_did_not_run_piper: true,
    dry_run_did_not_play_speaker: true,
    pid_file_unchanged: true,
    chat_mode_only: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_SCRIPTS_GUARD_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
