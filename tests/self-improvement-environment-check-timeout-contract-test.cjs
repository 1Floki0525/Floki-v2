'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();

function spawnBashTimeout(command, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_error) {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_error) {}
        finish({
          duration_ms: Date.now() - started,
          stdout,
          stderr,
          exit_code: 124,
          signalled: true
        });
      }, 200);
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      finish({ duration_ms: Date.now() - started, stdout, stderr, exit_code: code, signalled: signal === 'SIGTERM' || signal === 'SIGKILL' });
    });
  });
}

async function main() {
  assert.equal(config.environment_check_command_timeout_ms, 60000, 'environment_check_command_timeout_ms must be 60000');
  const sleepCmd = 'sleep 65; echo done';
  const startedAt = Date.now();
  const result = await spawnBashTimeout(sleepCmd, config.environment_check_command_timeout_ms);
  const elapsed = Date.now() - startedAt;
  assert.ok(result.signalled || result.exit_code === 124, 'sleep 65 should be cancelled by SIGTERM at 60s');
  assert.ok(elapsed < 65000, 'sleep 65 with 60s timeout should exit in < 65s, took ' + elapsed + 'ms');
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_ENV_TIMEOUT_PASS',
    environment_check_command_timeout_ms: config.environment_check_command_timeout_ms,
    child_signalled: result.signalled,
    duration_ms: elapsed,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_SELF_IMPROVEMENT_ENV_TIMEOUT_FAIL', error: error.message }, null, 2));
  process.exit(1);
});
