'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
const sandbox = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/sandbox.cjs'),
  'utf8'
);
const runtime = fs.readFileSync(
  path.join(ROOT, 'src/runtime/chat-local-runtime.cjs'),
  'utf8'
);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const terminalAuthority = fs.readFileSync(
  path.join(
    ROOT,
    'tests/rsi-nightly-training-terminal-authority-contract-test.cjs'
  ),
  'utf8'
);
const {
  readRawTerminal,
  selectRawTerminalSource
} = require('../src/runtime/raw-terminal-log.cjs');

assert.match(agent, /require\('\.\/pty-session\.cjs'\)/);
assert.match(agent, /ensureAgentPtySession/);
assert.match(agent, /terminalStreamFile/);
assert.match(agent, /pty_merged_output/);
assert.match(agent, /writeTerminalActivity/);
assert.match(agent, /model turn started/);
assert.match(agent, /model turn completed/);
assert.match(agent, /tool started/);
assert.match(agent, /tool completed/);
assert.match(agent, /safeTerminalActivityToken/);
assert.doesNotMatch(
  agent,
  /writeTerminalActivity\([^\n]*(?:message\.content|safe_thought_summary|felt_interpretation)/,
  'the terminal must show safe activity, never private model reasoning'
);
assert.doesNotMatch(
  agent,
  /spawn\('bash',\s*\['-lc',\s*command\]/,
  'agent shell commands must use the persistent PTY, not one bash per command'
);
assert.match(sandbox, /\/opt\/floki-self-improvement\/pty-session\.cjs/);
assert.match(runtime, /url\.pathname === '\/self-improvement\/terminal'/);
assert.match(
  pkg.scripts['test:node24'],
  /rsi-nightly-training-terminal-authority-contract-test\.cjs/
);
assert.match(
  terminalAuthority,
  /FLOKI_RSI_PTY_PERSISTENT_TEST_REGISTRY_V1/
);
assert.match(terminalAuthority, /spawnSync\(process\.execPath/);
for (const relative of [
  'tests/self-improvement-pty-session-contract-test.cjs',
  'tests/self-improvement-pty-integration-contract-test.cjs',
  'tests/self-improvement-run-now-permanent-workstation-contract-test.cjs'
]) {
  assert.equal(
    terminalAuthority.includes(relative),
    true,
    'permanent PTY registry is missing ' + relative
  );
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-pty-integration-'));
  try {
    const outbox = path.join(root, 'outbox');
    const candidates = path.join(root, 'candidates');
    const workspace = path.join(root, 'workspace');
    const training = path.join(root, 'training');
    const runtimeRoot = path.join(root, 'runtime');
    const runId = 'pty-run-1';
    const runRoot = path.join(outbox, runId + '.working');
    fs.mkdirSync(runRoot, { recursive: true });
    fs.mkdirSync(candidates, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(training, { recursive: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const terminalFile = path.join(runRoot, 'terminal.pty');
    fs.writeFileSync(
      terminalFile,
      '\u001b[32mfloki@sandbox:/home/floki/Floki-v2$\u001b[0m printf "hello\\n"\r\nhello\r\n'
    );
    const legacyLog = path.join(workspace, 'sandbox.log');
    fs.writeFileSync(legacyLog, 'fake audit log must not win\n');

    const config = {
      outbox_root: outbox,
      candidate_root: candidates,
      workspace_root: workspace,
      training_runtime_root: training,
      runtime_root: runtimeRoot,
      terminal_stream_file_name: 'terminal.pty',
      training_log_file_name: 'training.log'
    };
    const selected = selectRawTerminalSource({
      config,
      status: {
        current_run_kind: 'code',
        current_run_id: runId,
        last_sandbox_log_file: legacyLog
      },
      session: null
    });
    assert.equal(selected.kind, 'code_pty');
    assert.equal(selected.file, terminalFile);
    assert.equal(selected.active, true);
    assert.equal(selected.raw_pty, true);

    const payload = await readRawTerminal({
      config,
      status: {
        current_run_kind: 'code',
        current_run_id: runId,
        last_sandbox_log_file: legacyLog
      },
      session: null,
      cursor: 0,
      max_bytes: 65536
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.source_kind, 'code_pty');
    assert.equal(payload.raw_pty, true);
    assert.equal(payload.encoding, 'base64');
    assert.ok(payload.data_base64);
    assert.equal(payload.sequence_start, 0);
    assert.equal(payload.sequence_end, payload.next_cursor);
    assert.match(payload.text, /floki@sandbox:\/home\/floki\/Floki-v2\$/);
    assert.match(payload.text, /hello/);
    assert.equal(payload.text.includes('\u001b'), false);
    assert.equal(
      Buffer.from(payload.data_base64, 'base64').equals(
        fs.readFileSync(terminalFile)
      ),
      true
    );

    console.log(JSON.stringify({
      ok: true,
      marker: 'FLOKI_V2_RSI_PTY_INTEGRATION_CONTRACT_PASS',
      code_pty_outranks_fake_sandbox_log: true,
      byte_cursor_transport: true,
      base64_raw_pty_transport: true,
      compatibility_text_sanitized: true,
      sustained_safe_agent_activity_wired: true
    }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
