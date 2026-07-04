'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const {
  classifySandboxExit,
  idleEligibility,
  isNoCandidateSandboxFailure,
  noCandidateStatusPatch,
  shouldPreemptActiveRun
} = require('../src/self-improvement/worker.cjs');
const {
  claimCurrentStopRequest,
  currentContainerStopLock,
  readCurrentStopRequest
} = require('../src/self-improvement/sandbox.cjs');
const {
  createChatLocalInterfaceApi,
  safeDirectChildFileWithin,
  safeExistingFileWithin
} = require('../src/runtime/chat-local-interface-api.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');
const {
  readStatus,
  updateStatus
} = require('../src/self-improvement/store.cjs');

const oldActivity = new Date(Date.now() - 60000).toISOString();
const runtime = {
  api_ready: true,
  lifecycle: {
    is_awake: true,
    is_dreaming: false,
    manual_nap_active: false
  },
  active_turn: false,
  hearing: { speaking: true },
  started_at: oldActivity,
  client_ready_at: oldActivity
};
const status = { paused: false, failure_latched_at: null };
const eligibilityConfig = {
  minimum_available_memory_mb: 0,
  idle_seconds: 0,
  failure_requires_new_activity: true
};
assert.deepEqual(
  idleEligibility(runtime, status, eligibilityConfig, false),
  { eligible: false, reason: 'speech_output_active' },
  'Floki TTS may gate a new RSI cycle but must not preempt an active cycle'
);
assert.equal(shouldPreemptActiveRun('speech_output_active'), false);
assert.deepEqual(
  idleEligibility(
    { ...runtime, active_turn: true },
    status,
    eligibilityConfig,
    false
  ),
  { eligible: false, reason: 'foreground_turn_active' },
  'a genuine foreground turn must remain preemptive'
);
assert.equal(shouldPreemptActiveRun('foreground_turn_active'), true);
assert.equal(
  shouldPreemptActiveRun('sleep_or_rem_priority'),
  false,
  'sleep and REM priority may delay the next RSI start but must not kill an active sandbox'
);
assert.equal(
  shouldPreemptActiveRun('manual_nap_priority'),
  false,
  'manual nap REM must not kill an active RSI sandbox'
);
assert.equal(shouldPreemptActiveRun('idle_threshold_not_reached'), false);
assert.equal(shouldPreemptActiveRun('failure_waiting_for_new_activity'), false);
assert.equal(shouldPreemptActiveRun('chat_runtime_not_ready'), false);
assert.equal(
  isNoCandidateSandboxFailure('Error: agent iteration limit reached without a verified candidate'),
  true,
  'agent iteration exhaustion is a no-candidate cycle that must wait for new activity before retrying'
);
{
  const patch = noCandidateStatusPatch(
    'Error: agent iteration limit reached without a verified candidate',
    { log_file: '/tmp/sandbox.log' },
    '2026-06-25T00:00:00.000Z'
  );
  assert.equal(patch.state, 'waiting_for_idle');
  assert.equal(patch.phase, 'no_verified_candidate');
  assert.equal(patch.last_error, null, 'no-candidate cycles must not degrade the RSI UI with last_error');
  assert.equal(
    patch.failure_latched_at,
    null,
    'no-candidate cycles must stay retryable instead of becoming a hard failure latch'
  );
  assert.equal(
    patch.last_no_candidate_error.reason,
    'iteration_limit',
    'no-candidate status must expose a bounded structured reason instead of raw terminal text'
  );
  assert.equal(patch.last_no_candidate_error.terminal_log_file, '/tmp/sandbox.log');
}
assert.equal(
  isNoCandidateSandboxFailure('Error: write EPIPE'),
  false,
  'transport and sandbox infrastructure failures must remain real failures'
);
assert.deepEqual(
  classifySandboxExit({ code: 137, signal: null }, null, null),
  {
    ok: false,
    killed: true,
    phase: 'sandbox_killed_137',
    reason: 'sandbox_killed_137'
  },
  'unrequested status 137 must stay distinguishable from clean preemption'
);
assert.deepEqual(
  classifySandboxExit(
    { code: 137, signal: null },
    { reason: 'foreground_turn_active', requested_at: '2026-06-24T00:00:00.000Z' },
    null
  ),
  {
    ok: false,
    preempted: true,
    phase: 'preempted',
    reason: 'foreground_turn_active',
    requested_at: '2026-06-24T00:00:00.000Z'
  },
  'accepted foreground preemption must not be reported as sandbox_failed even when the container reports 137'
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-stop-'));
try {
  const stopConfig = {
    runtime_root: temp,
    candidate_root: path.join(temp, 'candidates'),
    workspace_root: path.join(temp, 'workspaces'),
    outbox_root: path.join(temp, 'outbox'),
    enabled: true,
    current_container_file_name: 'current-container.json',
    status_file_name: 'status.json',
    worker_pid_file_name: 'worker.pid',
    pause_file_name: 'paused',
    run_request_file_name: 'run-request.json',
    audit_file_name: 'audit.jsonl',
    approval_token_file_name: 'approval.token',
    promotion_lock_file_name: 'promotion.lock',
    worker_heartbeat_file_name: 'worker.heartbeat.json',
    sandbox_heartbeat_file_name: 'sandbox.heartbeat.json',
    ui_poll_ms: 1000,
    atomic_temp_random_bytes: 8
  };
  fs.writeFileSync(
    path.join(temp, stopConfig.current_container_file_name),
    JSON.stringify({ run_id: 'rsi-test', name: 'floki-rsi-test' }) + '\n'
  );
  const first = claimCurrentStopRequest('foreground_user_turn', stopConfig);
  assert.equal(first.claimed, true);
  assert.equal(first.request.reason, 'foreground_user_turn');
  const second = claimCurrentStopRequest('speech_output_active', stopConfig);
  assert.equal(second.claimed, false);
  assert.equal(second.request.reason, 'foreground_user_turn');
  assert.equal(readCurrentStopRequest(stopConfig).reason, 'foreground_user_turn');
  assert.equal(fs.existsSync(currentContainerStopLock(stopConfig)), true);
  updateStatus({
    state: 'experimenting',
    phase: 'sandbox_agent_running',
    current_run_id: 'rsi-test',
    current_container: 'floki-rsi-test',
    last_error: null
  }, stopConfig);
  fs.writeFileSync(path.join(temp, stopConfig.worker_pid_file_name), '999999999\n');
  const stale = readStatus(stopConfig);
  assert.equal(stale.worker_running, false);
  assert.equal(stale.state, 'failed');
  assert.equal(stale.phase, 'worker_not_running');
  assert.equal(stale.current_container, null);
  assert.match(stale.last_error, /worker is not running/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const worker = text('src/self-improvement/worker.cjs');
assert.match(worker, /speech_output_active/);
assert.match(worker, /execution\.read_stop_request\(\)/);
assert.match(worker, /classifySandboxExit/);
assert.match(worker, /if \(stopping\) break/);
assert.match(worker, /const previousStatus = readStatus\(config\)/);
assert.match(worker, /previousStatus\.failure_latched_at \|\| null/);

const agent = text('containers/self-improvement/agent.cjs');
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_SANDBOX_PREEMPTED/);
assert.match(agent, /process\.once\(signal, \(\) => exitForShutdown\(signal\)\)/);
assert.match(agent, /finally \{[\s\S]*process\.exit\(0\)/);

const adapter = text('apps/floki-neural-interface/src/integrations/floki/adapter.js');
assert.match(adapter, /async getSettings\(\)/);
assert.match(adapter, /settings\?\.connection\?\.autoReconnect/);
assert.match(adapter, /setTimeout\(\(\) => \{[\s\S]*connect\(\);[\s\S]*\}, reconnectDelay\)/);
assert.match(adapter, /type: 'stream\.connected'/);
assert.match(adapter, /type: 'stream\.closed'/);
assert.doesNotMatch(
  adapter,
  /reconnectTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\d+\s*\)/,
  'WebSocket reconnect timing must not use a numeric literal'
);

const chatPanel = text('apps/floki-neural-interface/src/components/chat/ChatPanel.jsx');
assert.match(chatPanel, /isAuthoritativeAssistantForPending/);
assert.match(chatPanel, /clientTurnStartedAt/);
assert.match(chatPanel, /'stream\.error'/);
assert.match(chatPanel, /'stream\.connected'/);

const dashboard = text('apps/floki-neural-interface/src/pages/SystemDashboard.jsx');
assert.match(dashboard, /logKey: 'Self-Improvement Worker'/);
const panel = text('apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx');
assert.match(panel, /Self-Improvement Worker/);
assert.match(panel, /Self-Improvement Sandbox/);

const secureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-log-root-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-rsi-log-outside-'));
try {
  const validLog = path.join(secureRoot, 'worker.log');
  const validSandboxDir = path.join(secureRoot, 'run-123');
  const validSandboxLog = path.join(validSandboxDir, 'sandbox.log');
  const nestedSandboxDir = path.join(secureRoot, 'run-123', 'nested');
  const nestedSandboxLog = path.join(nestedSandboxDir, 'sandbox.log');
  const wrongNameLog = path.join(validSandboxDir, 'other.log');
  const outsideLog = path.join(outsideRoot, 'outside.log');
  const escapeLink = path.join(secureRoot, 'escape.log');
  fs.mkdirSync(validSandboxDir);
  fs.mkdirSync(nestedSandboxDir);
  fs.writeFileSync(validLog, 'worker log\n');
  fs.writeFileSync(validSandboxLog, 'sandbox log\n');
  fs.writeFileSync(nestedSandboxLog, 'nested sandbox log\n');
  fs.writeFileSync(wrongNameLog, 'wrong name\n');
  fs.writeFileSync(outsideLog, 'outside log\n');
  fs.symlinkSync(outsideLog, escapeLink);
  assert.equal(safeExistingFileWithin(secureRoot, validLog), fs.realpathSync(validLog));
  assert.equal(safeExistingFileWithin(secureRoot, outsideLog), null);
  assert.equal(safeExistingFileWithin(secureRoot, escapeLink), null);
  assert.equal(
    safeDirectChildFileWithin(secureRoot, validSandboxLog, 'sandbox.log'),
    fs.realpathSync(validSandboxLog)
  );
  assert.equal(safeDirectChildFileWithin(secureRoot, nestedSandboxLog, 'sandbox.log'), null);
  assert.equal(safeDirectChildFileWithin(secureRoot, wrongNameLog, 'sandbox.log'), null);
  assert.equal(safeDirectChildFileWithin(secureRoot, escapeLink, 'sandbox.log'), null);
} finally {
  fs.rmSync(secureRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
}

const api = createChatLocalInterfaceApi({
  status: () => ({
    api_ready: true,
    websocket_ready: true,
    brain_loaded: true,
    memory_loaded: true,
    ready: true,
    lifecycle: { is_awake: true },
    hearing: {}
  })
});
assert.equal(api.logPath('../../etc/passwd').path, null);
const rsiConfig = loadSelfImprovementConfig();
const workerLog = api.logPath('Self-Improvement Worker');
if (workerLog.path) {
  const relative = path.relative(rsiConfig.runtime_root, workerLog.path);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
}
const sandboxLog = api.logPath('Self-Improvement Sandbox');
if (sandboxLog.path) {
  const relative = path.relative(rsiConfig.workspace_root, sandboxLog.path);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
}

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_PREEMPTION_CHAT_LOG_CONTRACT_PASS',
  tts_preemption_removed: true,
  sleep_rem_preemption_removed: true,
  no_candidate_failure_retryable: true,
  foreground_preemption_preserved: true,
  external_preemption_reason_persisted: true,
  transcript_poll_bridge_present: true,
  websocket_reconnect_present: true,
  rsi_logs_available: true
}, null, 2));
