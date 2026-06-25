'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function spawnWithTimeout(command, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
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
        finish({ duration_ms: timeoutMs + 250, stdout, stderr, signalled: true });
      }, 250);
    }, timeoutMs);
    if (signal) {
      const cancel = () => {
        clearTimeout(timer);
        try { child.kill('SIGTERM'); } catch (_error) {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_error) {}
          finish({ duration_ms: 0, stdout, stderr, signalled: true, cancelled: true });
        }, 250);
      };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }
    child.once('close', (code) => {
      clearTimeout(timer);
      finish({ duration_ms: 0, stdout, stderr, exit_code: code, signalled: false });
    });
    child.once('error', reject);
  });
}

async function main() {
  const controller = new AbortController();
  const startedAt = Date.now();
  const promise = spawnWithTimeout('sleep 30; echo done', 10000, controller.signal);
  setTimeout(() => controller.abort(), 500);
  const result = await promise;
  const elapsed = Date.now() - startedAt;
  assert.ok(result.signalled, 'sleep 30 should be cancelled by SIGTERM/SIGKILL after abort');
  assert.ok(elapsed < 5000, 'cancellation should complete in < 5s, took ' + elapsed + 'ms');
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_SHELL_CANCELLATION_PASS',
    cancelled: result.cancelled,
    signalled: result.signalled,
    elapsed_ms: elapsed,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_SELF_IMPROVEMENT_SHELL_CANCELLATION_FAIL', error: error.message }, null, 2));
  process.exit(1);
});
