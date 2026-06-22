'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');
const BIN_DIR = path.join(ROOT, 'bin');

function readScript(name) { return fs.readFileSync(path.join(BIN_DIR, name), 'utf8'); }
function runScript(name, env = {}) {
  return spawnSync('bash', [path.join(BIN_DIR, name)], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
}
function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1] || '{}');
}

function run() {
  const startScript = readScript('floki-chat-start.sh');
  const stopScript = readScript('floki-chat-stop.sh');
  const statusScript = readScript('floki-chat-status.sh');
  const proofScript = readScript('floki-chat-proof.sh');

  for (const [name, script] of Object.entries({ 'floki-chat-start.sh': startScript, 'floki-chat-stop.sh': stopScript, 'floki-chat-status.sh': statusScript, 'floki-chat-proof.sh': proofScript })) {
    assert.equal(script.includes('set -e'), false, name + ' must not use set -e');
    assert.equal(script.includes('pkill'), false, name + ' must not use pkill');
    assert.equal(script.includes('killall'), false, name + ' must not use killall');
    assert.equal(script.includes('chat_mode_only'), true, name + ' must report chat_mode_only');
  }

  assert.equal(startScript.includes('state/floki/chat/runtime'), true);
  assert.equal(stopScript.includes('state/floki/chat/runtime'), true);
  assert.equal(startScript.includes('src/runtime/chat-local-runtime.cjs'), true);
  assert.equal(startScript.includes('chat-local-runtime.pid'), true);
  assert.equal(startScript.includes('FLOKI_V2_CHAT_START_SCRIPT_PASS'), true);
  assert.equal(startScript.includes('FLOKI_ALLOW_CHAT_MODE_LOOP=1'), false);
  assert.equal(startScript.includes('--runner'), false);
  assert.equal(startScript.includes('ollama'), false);
  assert.equal(stopScript.includes('src/runtime/chat-local-runtime.cjs'), true);
  assert.equal(stopScript.includes('FLOKI_V2_CHAT_STOP_SCRIPT_PASS'), true);
  assert.equal(statusScript.includes('chat-local-runtime.status.json'), true);
  assert.equal(proofScript.includes('proof:chat-mode-loop'), true, 'bounded proof path remains isolated for tests only');

  const startDry = runScript('floki-chat-start.sh', { FLOKI_CHAT_SCRIPT_DRY_RUN: '1' });
  assert.equal(startDry.status, 0, startDry.stderr);
  const startStatus = parseLastJson(startDry.stdout);
  assert.equal(startStatus.marker, 'FLOKI_V2_CHAT_START_SCRIPT_PASS');
  assert.equal(startStatus.dry_run, true);

  const stopDry = runScript('floki-chat-stop.sh', { FLOKI_CHAT_SCRIPT_DRY_RUN: '1' });
  assert.equal(stopDry.status, 0, stopDry.stderr);
  const stopStatus = parseLastJson(stopDry.stdout);
  assert.equal(stopStatus.marker, 'FLOKI_V2_CHAT_STOP_SCRIPT_PASS');
  assert.equal(stopStatus.dry_run, true);

  const proofDry = runScript('floki-chat-proof.sh', { FLOKI_CHAT_SCRIPT_DRY_RUN: '1' });
  assert.equal(proofDry.status, 0, proofDry.stderr);
  const proofStatus = parseLastJson(proofDry.stdout);
  assert.equal(proofStatus.marker, 'FLOKI_V2_CHAT_PROOF_SCRIPT_PASS');
  assert.equal(proofStatus.bounded, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_SCRIPTS_CONTRACT_PASS',
    production_runtime_entrypoint: 'src/runtime/chat-local-runtime.cjs',
    bounded_proof_isolated_from_production_start: true,
    start_script_marker: startStatus.marker,
    stop_script_marker: stopStatus.marker,
    proof_script_marker: proofStatus.marker,
    no_broad_process_kill: true,
    start_does_not_unload_ollama: true,
    chat_mode_only: true
  }, null, 2));
}

try { run(); } catch (error) {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_SCRIPTS_CONTRACT_FAIL', error: error.message, chat_mode_only: true }, null, 2));
  process.exit(1);
}
