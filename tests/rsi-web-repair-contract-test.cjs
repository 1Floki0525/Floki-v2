'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');

// --- Defect 1: RSI status correction ---

const { getModuleConfig, getAllModuleConfigs } = require(path.join(root, 'src/control-plane/module-registry.cjs'));

const rsi = getModuleConfig('rsi');
assert.equal(rsi.key, 'rsi');
assert.ok(rsi.heartbeat_file.endsWith('worker.heartbeat.json'), 'RSI heartbeat must use dedicated worker file');
assert.ok(rsi.uptime_file.endsWith('worker.pid'), 'RSI uptime must use dedicated worker PID file');
assert.ok(!rsi.heartbeat_file.includes('chat-local-runtime'), 'RSI must not use main runtime heartbeat');

const allCards = getAllModuleConfigs();
assert.equal(allCards.length, 12, 'Exactly 12 module cards');
const rsiCard = allCards.find((m) => m.key === 'rsi');
assert.ok(rsiCard, 'RSI card must exist in module registry');

console.log('PASS: Defect 1 — RSI status correction (heartbeat, PID, card count)');

// --- Defect 2: No duplicate legacy RSI card ---

const systemDashboard = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/src/pages/SystemDashboard.jsx'), 'utf8'
);
assert.ok(!systemDashboard.includes('selfImprovementService'), 'Legacy selfImprovementService function must be removed');
assert.ok(!systemDashboard.includes("ServiceStatus"), 'ServiceStatus import must be removed');
assert.ok(systemDashboard.includes("s.key === 'rsi'"), 'Navigation panel must use authoritative RSI card by key');

console.log('PASS: Defect 2 — Duplicate legacy RSI card removed');

// --- Defect 3: No ctrl/sbox badges or synthetic labels ---

const rsiLab = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/src/pages/RSILab.jsx'), 'utf8'
);
assert.ok(!rsiLab.includes("item.source === 'controller' ? 'ctrl'"), 'ctrl badge must be removed');
assert.ok(!rsiLab.includes("item.source === 'sandbox' ? 'sbox'"), 'sbox badge must be removed');
assert.ok(!rsiLab.includes('formatTorontoTime'), 'Synthetic timestamp column must be removed');
assert.ok(!rsiLab.includes('[worker] started'), 'Synthetic [worker] label must be removed');
assert.ok(!rsiLab.includes('[cycle end]'), 'Synthetic [cycle end] label must be removed');
assert.ok(!rsiLab.includes('[sandbox] started'), 'Synthetic [sandbox] label must be removed');

console.log('PASS: Defect 3 — No ctrl/sbox badges or synthetic labels');

// --- Defect 4 Cause A: Heartbeat writers do not modify status file ---

const storeSource = fs.readFileSync(
  path.join(root, 'src/self-improvement/store.cjs'), 'utf8'
);

const touchWorkerMatch = storeSource.match(/function touchWorkerHeartbeat[\s\S]*?\n\}/);
assert.ok(touchWorkerMatch, 'touchWorkerHeartbeat must exist');
const touchWorkerBody = touchWorkerMatch[0];
assert.ok(!touchWorkerBody.includes('atomicJson(p.statusFile'), 'Worker heartbeat must not rewrite status file');
assert.ok(!touchWorkerBody.includes('safeJson(p.statusFile'), 'Worker heartbeat must not read status file');

const touchSandboxMatch = storeSource.match(/function touchSandboxHeartbeat[\s\S]*?\n\}/);
assert.ok(touchSandboxMatch, 'touchSandboxHeartbeat must exist');
const touchSandboxBody = touchSandboxMatch[0];
assert.ok(!touchSandboxBody.includes('atomicJson(p.statusFile'), 'Sandbox heartbeat must not rewrite status file');
assert.ok(!touchSandboxBody.includes('safeJson(p.statusFile'), 'Sandbox heartbeat must not read status file');

console.log('PASS: Defect 4A — Heartbeat writers do not modify status file');

// --- Defect 4 Cause B: Stable last-run log identity ---

const runtimeSource = fs.readFileSync(
  path.join(root, 'src/runtime/chat-local-runtime.cjs'), 'utf8'
);
assert.ok(runtimeSource.includes('const lastSandboxLogFile = rsiStatus?.last_sandbox_log_file || null'),
  'Activity endpoint must retain last_sandbox_log_file when run completes');
assert.ok(runtimeSource.includes('displayRunId'),
  'Activity endpoint must use displayRunId for stable log identity');

console.log('PASS: Defect 4B — Stable last-run log identity');

// --- Defect 4 Cause C: Stale polling response rejection ---

assert.ok(rsiLab.includes('let generation = 0'), 'Generation counter must exist for stale response guard');
assert.ok(rsiLab.includes('lastAppliedGeneration'), 'Last applied generation must be tracked');
assert.ok(rsiLab.includes('thisGeneration <= lastAppliedGeneration'), 'Stale responses must be rejected');

console.log('PASS: Defect 4C — Stale polling response rejection');

// --- Defect 5: classifyNoCandidateReason ---

const workerSource = fs.readFileSync(
  path.join(root, 'src/self-improvement/worker.cjs'), 'utf8'
);
assert.ok(workerSource.includes('function classifyNoCandidateReason'), 'classifyNoCandidateReason must exist');
assert.ok(workerSource.includes("'iteration_limit'"), 'Must classify iteration_limit');
assert.ok(workerSource.includes("'wall_clock_limit'"), 'Must classify wall_clock_limit');
assert.ok(workerSource.includes("'no_source_change'"), 'Must classify no_source_change');
assert.ok(workerSource.includes("'model_request_failure'"), 'Must classify model_request_failure');
assert.ok(workerSource.includes("'focused_test_failure'"), 'Must classify focused_test_failure');
assert.ok(workerSource.includes('classifyNoCandidateReason(completionSummary)'), 'Must use classifier in audit');
assert.ok(workerSource.includes('classifyNoCandidateReason(message)'), 'Must use classifier in error path');

console.log('PASS: Defect 5 — classifyNoCandidateReason surfaces exact reasons');

// --- Defect 6: Public API routing contract ---

const adapterSource = fs.readFileSync(
  path.join(root, 'apps/floki-neural-interface/src/integrations/floki/adapter.js'), 'utf8'
);
assert.ok(adapterSource.includes('bridge()'), 'Adapter must use bridge (Electron IPC or web fetch)');

console.log('PASS: Defect 6 — Public API routing config contract');

// --- Android migration ---

const androidDir = path.join(root, 'apps/Floki-mobile-app');
assert.ok(fs.existsSync(androidDir), 'apps/Floki-mobile-app must exist');
assert.ok(fs.existsSync(path.join(androidDir, 'gradlew')), 'Gradle wrapper must exist');
assert.ok(fs.existsSync(path.join(androidDir, 'settings.gradle.kts')), 'Settings must exist');
assert.ok(fs.existsSync(path.join(androidDir, 'app/build.gradle.kts')), 'App build file must exist');
assert.ok(fs.existsSync(path.join(androidDir, 'app/src/main/AndroidManifest.xml')), 'Manifest must exist');
assert.ok(fs.existsSync(path.join(androidDir, 'install-apk.sh')), 'APK install script must exist');
assert.ok(!fs.existsSync(path.join(androidDir, '.git')), 'No nested .git');
assert.ok(!fs.existsSync(path.join(androidDir, 'local.properties')), 'No local.properties staged');

const neuralDir = path.join(root, 'apps/floki-neural-interface');
assert.ok(fs.existsSync(neuralDir), 'apps/floki-neural-interface must remain present');

console.log('PASS: Android migration — file inventory verified');

console.log('\nFLOKI_V2_RSI_WEB_REPAIR_CONTRACT_PASS');
