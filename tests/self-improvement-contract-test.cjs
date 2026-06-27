'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function text(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const required = [
  'src/self-improvement/config.cjs',
  'src/self-improvement/config-cli.cjs',
  'src/self-improvement/model-proxy.cjs',
  'src/self-improvement/store.cjs',
  'src/self-improvement/snapshot.cjs',
  'src/self-improvement/sandbox.cjs',
  'src/self-improvement/worker.cjs',
  'src/self-improvement/api.cjs',
  'src/self-improvement/promotion.cjs',
  'src/self-improvement/promoter.cjs',
  'containers/self-improvement/Containerfile',
  'containers/self-improvement/agent.cjs',
  'bin/floki-self-improvement-start.sh',
  'bin/floki-self-improvement-stop.sh',
  'bin/floki-self-improvement-status.sh',
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
];

for (const relative of required) {
  assert.equal(
    fs.existsSync(path.join(ROOT, relative)),
    true,
    'missing ' + relative
  );
}

const sandbox = text('src/self-improvement/sandbox.cjs');
assert.match(sandbox, /config\.cap_drop/);
assert.match(sandbox, /config\.security_opt/);
assert.match(sandbox, /config\.network_mode/);
assert.match(sandbox, /config\.workspace_mount_path/);
assert.match(sandbox, /config\.outbox_mount_path/);
assert.match(sandbox, /config\.sandbox_engine/);
assert.match(sandbox, /imageSourceFingerprint/);
assert.match(sandbox, /config\.model_proxy_mount_path/);
assert.doesNotMatch(sandbox, /--network[=',\s]+host/);
assert.doesNotMatch(sandbox, /docker\.sock|podman\.sock/);
assert.doesNotMatch(sandbox, /project_root\s*\+\s*['"]:\/workspace/);

const containerfile = text('containers/self-improvement/Containerfile');
assert.match(containerfile, /^ARG BASE_IMAGE$/m);
assert.match(containerfile, /^FROM \$\{BASE_IMAGE\}$/m);
assert.match(containerfile, /^ARG APT_PACKAGES$/m);
assert.match(containerfile, /^ARG CONTEXT7_PACKAGE$/m);
assert.match(containerfile, /^ARG CONTEXT7_VERSION$/m);
assert.match(containerfile, /^ARG WORKSPACE_PATH$/m);

const agent = text('containers/self-improvement/agent.cjs');
assert.match(agent, /FLOKI_RSI_CONFIG_FILE/);
assert.match(agent, /context7_resolve_library/);
assert.match(agent, /context7_query_docs/);
assert.match(agent, /web_search/);
assert.match(agent, /browser_fetch/);
assert.match(agent, /arxiv_search/);
assert.match(agent, /crossref_search/);
assert.match(agent, /github_search/);
assert.match(agent, /run_verification/);
assert.match(agent, /finalize_candidate/);
assert.match(agent, /self_approval_possible: false/);
assert.match(agent, /git add -N/);
assert.doesNotMatch(agent, /shell\(['"]git (?:reset|clean|restore)/);
assert.doesNotMatch(agent, /shell\(['"]sudo\s/);
assert.match(agent, /symlink and Git submodule changes are not allowed/);

const store = text('src/self-improvement/store.cjs');
assert.match(store, /timingSafeEqual/);
assert.match(store, /config\.approval_token_bytes/);
assert.match(store, /config\.atomic_temp_random_bytes/);

const promoter = text('src/self-improvement/promoter.cjs');
assert.match(promoter, /verifyBaseHashes/);
assert.match(promoter, /ensureTestScriptNotWeakened/);
assert.match(promoter, /failed_rolled_back/);
assert.match(promoter, /config\.max_changed_files/);
assert.match(promoter, /config\.max_patch_bytes/);
assert.match(
  promoter,
  /applyPatch\(config\.project_root, patchFile, true, config\)/
);
assert.doesNotMatch(
  promoter,
  /run\(['"]git['"], \[['"](?:reset|clean|restore)/
);

const runtime = text('src/runtime/chat-local-runtime.cjs');
assert.match(runtime, /createSelfImprovementApi/);
assert.match(runtime, /\/self-improvement\/status/);
assert.match(runtime, /\/self-improvement\/candidates/);
assert.match(runtime, /\/self-improvement\/approve/);
assert.match(
  runtime,
  /selfImprovementApi\.preempt\('foreground_user_turn'\)/
);

const preload = text('apps/floki-neural-interface/electron/preload.cjs');
assert.match(preload, /getSelfImprovementStatus/);
assert.match(preload, /approveSelfImprovement/);
assert.match(preload, /denySelfImprovement/);

const main = text('apps/floki-neural-interface/electron/main.cjs');
assert.match(main, /ensureApprovalToken/);
assert.match(main, /floki:get-self-improvement-status/);
assert.match(main, /floki:approve-self-improvement/);

const system = text(
  'apps/floki-neural-interface/src/pages/SystemDashboard.jsx'
);
assert.doesNotMatch(system, /import.*SelfImprovementPanel/, 'SystemDashboard must not import full panel — moved to RSI Lab');
assert.match(system, /rsi-module-card/, 'SystemDashboard must show compact RSI module card');
assert.match(system, /Open RSI Lab/, 'SystemDashboard must link to RSI Lab');

const rsiLab = text('apps/floki-neural-interface/src/pages/RSILab.jsx');
assert.match(rsiLab, /SelfImprovementPanel/, 'RSILab page must render the full SelfImprovementPanel');

const panel = text(
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
);
assert.match(panel, /ui_poll_ms/);
assert.doesNotMatch(panel, /setInterval\s*\([^,]+,\s*\d+/);

const nav = text(
  'apps/floki-neural-interface/src/components/shared/NavRail.jsx'
);
assert.match(nav, /selfImprovementPending/);

const home = text('apps/floki-neural-interface/src/pages/Home.jsx');
assert.match(home, /pendingAlerted/);
assert.match(home, /toast\.warning/);
assert.match(home, /selfImprovementCandidateId/);
assert.match(home, /onNavigate=\{setActiveTab\}/);

const chatInterface = text(
  'apps/floki-neural-interface/src/pages/ChatInterface.jsx'
);
assert.match(chatInterface, /self-improvement-chat-alert/);
assert.match(chatInterface, /Upgrade ready for review/);
assert.match(chatInterface, /onNavigate\?\.\('system'\)/);

const configTemplate = text('config/chat.config.yaml.temp');
assert.match(configTemplate, /^self_improvement:/m);
assert.match(configTemplate, /approval_required:\s+true/);
assert.match(configTemplate, /context7_package_version:/);
assert.match(configTemplate, /web_search_url_template:/);
assert.match(configTemplate, /promotion_restart_command:/);
assert.match(configTemplate, /snapshot_exclude_patterns:.*\.env/);
assert.match(configTemplate, /snapshot_exclude_patterns:.*\.npmrc/);
assert.match(configTemplate, /snapshot_sanitized_npmrc_lines:\s*"engine-strict=true"/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RECURSIVE_SELF_IMPROVEMENT_CONTRACT_PASS'
}, null, 2));
