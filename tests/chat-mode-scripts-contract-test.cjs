'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT } = require('../src/config/floki-config.cjs');
const BIN_DIR = path.join(ROOT, 'bin');

function readScript(name) {
  return fs.readFileSync(path.join(BIN_DIR, name), 'utf8');
}

function runScript(name, env = {}) {
  return spawnSync('bash', [path.join(BIN_DIR, name)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    },
    timeout: 120000
  });
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '{}';
  return JSON.parse(last);
}

function run() {
  const startScript = readScript('floki-chat-start.sh');
  const stopScript = readScript('floki-chat-stop.sh');
  const statusScript = readScript('floki-chat-status.sh');
  const proofScript = readScript('floki-chat-proof.sh');

  for (const [name, script] of Object.entries({
    'floki-chat-start.sh': startScript,
    'floki-chat-stop.sh': stopScript,
    'floki-chat-status.sh': statusScript,
    'floki-chat-proof.sh': proofScript
  })) {
    assert.equal(script.includes('set -e'), false, name + ' must not use set -e');
    assert.equal(script.includes('pkill'), false, name + ' must not use pkill');
    assert.equal(script.includes('killall'), false, name + ' must not use killall');
    assert.equal(script.includes('chat_mode_only'), true, name + ' must report chat_mode_only');
  }

  assert.equal(startScript.includes('state/floki/chat/runtime'), true);
  assert.equal(stopScript.includes('state/floki/chat/runtime'), true);
  assert.equal(statusScript.includes('chat-mode-script-status.cjs'), true);
  assert.equal(startScript.includes('FLOKI_V2_CHAT_START_SCRIPT_PASS'), true);
  assert.equal(startScript.includes('--runner'), true);
  assert.equal(startScript.includes('FLOKI_ALLOW_CHAT_MODE_LOOP=1'), true);
  assert.equal(startScript.includes('ollama'), false);
  assert.equal(stopScript.includes('FLOKI_V2_CHAT_STOP_SCRIPT_PASS'), true);
  assert.equal(stopScript.includes('runner_active "$PID"'), true);
  assert.equal(proofScript.includes('FLOKI_CHAT_MODE_LOOP_TURNS="${FLOKI_CHAT_MODE_LOOP_TURNS:-1}"'), true);
  assert.equal(proofScript.includes('proof:chat-mode-loop'), true);
  assert.equal(proofScript.includes('proof:self-echo-regression'), true);

  const startDry = runScript('floki-chat-start.sh', {
    FLOKI_CHAT_SCRIPT_DRY_RUN: '1'
  });
  assert.equal(startDry.status, 0, startDry.stderr);
  const startStatus = parseLastJson(startDry.stdout);
  assert.equal(startStatus.marker, 'FLOKI_V2_CHAT_START_SCRIPT_PASS');
  assert.equal(startStatus.dry_run, true);

  const stopDry = runScript('floki-chat-stop.sh', {
    FLOKI_CHAT_SCRIPT_DRY_RUN: '1'
  });
  assert.equal(stopDry.status, 0, stopDry.stderr);
  const stopStatus = parseLastJson(stopDry.stdout);
  assert.equal(stopStatus.marker, 'FLOKI_V2_CHAT_STOP_SCRIPT_PASS');
  assert.equal(stopStatus.dry_run, true);

  const proofDry = runScript('floki-chat-proof.sh', {
    FLOKI_CHAT_SCRIPT_DRY_RUN: '1'
  });
  assert.equal(proofDry.status, 0, proofDry.stderr);
  const proofStatus = parseLastJson(proofDry.stdout);
  assert.equal(proofStatus.marker, 'FLOKI_V2_CHAT_PROOF_SCRIPT_PASS');
  assert.equal(proofStatus.bounded, true);

  const statusRun = runScript('floki-chat-status.sh');
  assert.equal(statusRun.status, 0, statusRun.stderr);
  const scriptStatus = JSON.parse(statusRun.stdout);
  assert.equal(scriptStatus.marker, 'FLOKI_V2_CHAT_STATUS_SCRIPT_PASS');
  assert.equal(typeof scriptStatus.loop_active, 'boolean');
  assert.equal(typeof scriptStatus.qwen_model, 'string');
  assert.ok(scriptStatus.qwen_model.length > 0, 'qwen_model must be a non-empty string from YAML');
  assert.equal(typeof scriptStatus.piper_voice, 'string');
  assert.equal(scriptStatus.speaker_guard.allowed_now, false);
  assert.equal(scriptStatus.reply_only_when_wake_gated, true);
  assert.equal(scriptStatus.game_mode_started, false);
  assert.equal(scriptStatus.chat_mode_only, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_SCRIPTS_CONTRACT_PASS',
    start_script_marker: startStatus.marker,
    stop_script_marker: stopStatus.marker,
    status_script_marker: scriptStatus.marker,
    proof_script_marker: proofStatus.marker,
    bounded_proof_script: proofStatus.bounded,
    pid_files_under_chat_runtime: true,
    no_broad_process_kill: true,
    start_does_not_unload_ollama: true,
    chat_mode_only: true
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_CHAT_SCRIPTS_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true
  }, null, 2));
  process.exit(1);
}
