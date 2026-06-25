'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

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

const worker = text('src/self-improvement/worker.cjs');
assert.match(worker, /failure_waiting_for_new_activity/);
assert.match(worker, /failure_latched_at/);
assert.match(worker, /execution\.read_error_tail/);
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
assert.match(system, /selfImprovementService/);
assert.match(system, /getSelfImprovementStatus/);
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
  'sandbox_log_file_name',
  'sandbox_error_tail_chars',
  'failure_requires_new_activity'
]) {
  assert.match(configTemplate, new RegExp('^  ' + key + ':', 'm'));
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
const status = {
  paused: false,
  failure_latched_at: new Date(Date.now() + 1000).toISOString()
};
const config = {
  minimum_available_memory_mb: 0,
  idle_seconds: 0,
  failure_requires_new_activity: true
};
assert.deepEqual(
  idleEligibility(runtime, status, config, false),
  { eligible: false, reason: 'failure_waiting_for_new_activity' }
);
assert.equal(idleEligibility(runtime, status, config, true).eligible, true);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_RUNTIME_CONTROLS_REPAIR_CONTRACT_PASS'
}, null, 2));
