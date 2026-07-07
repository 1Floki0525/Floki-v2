'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const { writeSanitizedNpmrc } = require('../src/self-improvement/snapshot.cjs');

const proxy = text('src/self-improvement/model-proxy.cjs');
assert.match(proxy, /socketPath/);
assert.match(proxy, /resolved\.model_proxy_request_timeout_ms/);
assert.match(proxy, /resolved\.model_proxy_health_path/);

const sandbox = text('src/self-improvement/sandbox.cjs');
assert.match(sandbox, /imageSourceFingerprint/);
assert.match(sandbox, /config\.image_source_label/);
assert.match(sandbox, /config\.image_source_files/);
assert.match(sandbox, /config\.model_proxy_mount_path/);
assert.match(sandbox, /config\.sandbox_error_tail_chars/);
assert.doesNotMatch(sandbox, /--network[=',\s]+host/);

const snapshot = text('src/self-improvement/snapshot.cjs');
assert.match(snapshot, /writeSanitizedNpmrc/);
assert.match(snapshot, /snapshot_sanitized_npmrc_lines/);

const worker = text('src/self-improvement/worker.cjs');
assert.doesNotMatch(
  worker,
  /failure_waiting_for_new_activity/,
  'a latched failure must not require unrelated new activity'
);
assert.match(worker, /failure_latched_at/);
assert.match(worker, /execution\.read_error_tail/);
assert.match(worker, /last_no_candidate_error/);
assert.match(worker, /fs\.rmSync\([\s\S]*config\.sandbox_heartbeat_file_name/);
assert.match(worker, /failure_latched_at:\s*null/);
assert.match(worker, /createModelProxy/);
assert.match(worker, /setInterval\(\(\) => \{[\s\S]*updateStatus\(\{\}, config\)/);

const promotion = text('src/self-improvement/promotion.cjs');
assert.match(promotion, /state:\s*'queued'/);
assert.match(promotion, /phase:\s*'maker_requested_cycle'/);

const agent = text('containers/self-improvement/agent.cjs');
assert.match(agent, /model_socket_path/);
assert.match(agent, /socketPath:\s*MODEL_SOCKET_PATH/);
assert.match(agent, /git status --short --untracked-files=no/);
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT/);
assert.match(agent, /fs\.writeSync\(1,\s*record \+ '\\n'\)/);
assert.doesNotMatch(agent, /host\.containers\.internal/);

const system = text('apps/floki-neural-interface/src/pages/SystemDashboard.jsx');
assert.match(system, /Recursive Self-Improvement/);
assert.match(system, /getSelfImprovementStatus/);
assert.match(system, /s\.key === 'rsi'/);
assert.match(system, /pollMsRef/);
assert.match(system, /setTimeout\(run,\s*pollMsRef\.current\)/);

const panel = text('apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx');
assert.match(panel, /actionFeedback/);
assert.match(panel, /lastRefreshedAt/);
assert.match(panel, /maker_requested_cycle/);
assert.match(panel, /result\?\.status \|\| nextStatus/);
assert.match(panel, /pollMsRef/);
assert.match(panel, /setTimeout\(run,\s*pollMsRef\.current\)/);
assert.match(panel, /Pause verification failed/);
assert.match(panel, /Resume verification failed/);

const startScript = text('bin/floki-self-improvement-start.sh');
assert.match(startScript, /setsid nohup bash "\$NODE_RUN" node src\/self-improvement\/worker\.cjs --service/);

const configTemplate = text('config/chat.config.yaml.temp');
for (const key of [
  'image_source_label',
  'image_source_files',
  'image_fingerprint_algorithm',
  'model_proxy_root',
  'model_proxy_socket_name',
  'model_proxy_mount_path',
  'model_proxy_mount_options',
  'model_proxy_health_path',
  'model_proxy_start_timeout_ms',
  'model_proxy_request_timeout_ms',
  'model_response_max_bytes',
  'snapshot_sanitized_npmrc_lines',
  'sandbox_log_file_name',
  'sandbox_error_tail_chars',
  'run_now_ack_timeout_ms',
  'run_now_ack_poll_ms',
  'service_stop_command_timeout_seconds'
]) {
  assert.match(configTemplate, new RegExp('^  ' + key + ':', 'm'));
}
assert.match(configTemplate, /snapshot_exclude_patterns:.*\.npmrc/);
assert.match(configTemplate, /snapshot_sanitized_npmrc_lines:\s*"engine-strict=true"/);

const snapshotRoot = fs.mkdtempSync(path.join('/tmp', 'floki-rsi-snapshot-npmrc-'));
try {
  const npmrcFile = writeSanitizedNpmrc(snapshotRoot, {
    snapshot_sanitized_npmrc_lines: 'engine-strict=true'
  });
  const npmrc = fs.readFileSync(npmrcFile, 'utf8');
  assert.equal(path.basename(npmrcFile), '.npmrc');
  assert.equal(npmrc, 'engine-strict=true\n');
  assert.doesNotMatch(npmrc, /auth|token|password/i);
} finally {
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
}

const { idleEligibility } = require('../src/self-improvement/worker.cjs');
const activity = new Date().toISOString();
const runtime = {
  api_ready: true,
  lifecycle: { is_awake: true, is_dreaming: false, manual_nap_active: false },
  active_turn: false,
  hearing: { speaking: false },
  started_at: activity,
  client_ready_at: activity
};
// The failure latch no longer blocks new cycles: a latched failure must not
// require unrelated new activity before the next eligible cycle runs.
const status = {
  paused: false,
  failure_latched_at: new Date(Date.now() + 1000).toISOString()
};
const config = {
  minimum_available_memory_mb: 0,
  idle_seconds: 0
};
assert.equal(idleEligibility(runtime, status, config, false).eligible, true);
assert.equal(idleEligibility(runtime, status, config, true).eligible, true);

const {
  noSafeCandidateStatusPatch
} = require('../src/self-improvement/worker.cjs');
const noSafePatch = noSafeCandidateStatusPatch(
  {
    run_id: 'rsi-contract-test',
    detailed_reason: 'evidence-backed decision fixture',
    evidence_findings: ['a', 'b', 'c'],
    considered_alternatives: [
      { alternative: 'x', rejection_reason: 'r1' },
      { alternative: 'y', rejection_reason: 'r2' }
    ]
  },
  { log_file: '/tmp/sandbox.log' },
  new Date().toISOString()
);
assert.equal(noSafePatch.failure_latched_at, null);
assert.equal(noSafePatch.phase, 'no_safe_candidate');

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_RUNTIME_CONTROLS_REPAIR_CONTRACT_PASS'
}, null, 2));
