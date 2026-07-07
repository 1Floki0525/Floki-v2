'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPtySession,
  SENTINEL_TAG,
  READY_TAG
} = require('../src/self-improvement/pty-session.cjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pty-session-'));
  const streamFile = path.join(root, 'terminal.pty');
  const events = [];
  const session = createPtySession({
    stream_file: streamFile,
    cwd: root,
    env: { ...process.env, HOME: root },
    rows: 24,
    cols: 100,
    stream_max_bytes: 1024 * 1024,
    output_max_bytes: 256 * 1024,
    sentinel_grace_ms: 1500,
    interrupt_grace_ms: 250,
    shell_command: 'bash --noprofile --norc -i',
    prompt: '\\u@\\h:${PWD}$ ',
    on_event(type, detail) {
      events.push({ type, detail });
    }
  });

  try {
    const identity = await session.run(
      'printf "%s|%s|%s|%s\\n" "$(id -u)" "$(id -un)" "$(hostname)" "$PWD"',
      { timeout_ms: 5000 }
    );
    assert.equal(identity.status, 0);
    assert.match(identity.stdout, /^\d+\|[^|]+\|[^|]+\|\//);
    assert.equal(identity.stderr, '');
    assert.equal(identity.pty_merged_output, true);

    const change = await session.run(
      'cd /tmp && export FLOKI_PTY_PERSIST=works',
      { timeout_ms: 5000 }
    );
    assert.equal(change.status, 0);
    assert.equal(change.pwd, '/tmp');

    const persisted = await session.run(
      'printf "%s|%s\\n" "$PWD" "$FLOKI_PTY_PERSIST"',
      { timeout_ms: 5000 }
    );
    assert.equal(persisted.status, 0);
    assert.equal(persisted.stdout, '/tmp|works');
    assert.equal(persisted.pty_generation, change.pty_generation);

    const streaming = session.run(
      'for i in 1 2 3 4; do echo "stream-$i"; sleep 0.2; done',
      { timeout_ms: 5000 }
    );
    const observedBeforeCompletion = await waitFor(() => {
      if (!fs.existsSync(streamFile)) return false;
      const value = fs.readFileSync(streamFile, 'utf8');
      return value.includes('stream-1') && !value.includes('stream-4');
    });
    assert.equal(
      observedBeforeCompletion,
      true,
      'PTY bytes must reach the stream file before command completion'
    );
    const streamed = await streaming;
    assert.equal(streamed.status, 0);
    assert.match(streamed.stdout, /stream-1/);
    assert.match(streamed.stdout, /stream-4/);

    const failed = await session.run(
      "bash -lc 'printf \"failure-output\\n\"; exit 7'",
      { timeout_ms: 5000 }
    );
    assert.equal(failed.status, 7);
    assert.match(failed.stdout, /failure-output/);

    const timedOut = await session.run('sleep 5', { timeout_ms: 150 });
    assert.equal(timedOut.timed_out, true);

    const bytesBeforeActivity = fs.statSync(streamFile).size;
    assert.equal(session.writeActivity('cognition · model turn started'), true);
    const activityVisible = await waitFor(() => {
      const value = fs.readFileSync(streamFile, 'utf8');
      return value.includes('[RSI]') &&
        value.includes('cognition · model turn started');
    });
    assert.equal(activityVisible, true, 'safe agent activity must advance terminal.pty between shell commands');
    assert.ok(fs.statSync(streamFile).size > bytesBeforeActivity);

    const raw = fs.readFileSync(streamFile);
    assert.equal(raw.includes(Buffer.from(SENTINEL_TAG)), false);
    assert.equal(raw.includes(Buffer.from(READY_TAG)), false);
    assert.ok(events.some((event) => event.type === 'pty_opened'));
    assert.ok(events.some((event) => event.type === 'stream_chunk'));

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_RSI_PTY_SESSION_CONTRACT_PASS',
      persistent_shell_state: true,
      live_stream_before_completion: true,
      exact_exit_status: true,
      timeout_interrupt: true,
      control_sentinels_hidden: true,
      safe_agent_activity_streamed: true
    }, null, 2));
  } finally {
    session.close('contract_complete');
    await sleep(100);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
