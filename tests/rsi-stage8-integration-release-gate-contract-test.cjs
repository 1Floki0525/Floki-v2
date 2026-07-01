'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSleepConfig } = require('../src/config/floki-config.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const nodeMajor = Number(process.versions.node.split('.')[0]);
assert.equal(Number.isInteger(nodeMajor) && nodeMajor >= 24, true, 'Node 24 or newer is required');
assert.equal(read('.nvmrc').trim(), '24');
assert.equal(read('.node-version').trim(), '24');

const requiredFiles = [
  'src/self-improvement/repo-intelligence.cjs',
  'src/self-improvement/skills.cjs',
  'src/self-improvement/roles.cjs',
  'src/self-improvement/state-machine.cjs',
  'src/self-improvement/goal-formation.cjs',
  'src/self-improvement/memory-capsules.cjs',
  'src/self-improvement/run-kinds.cjs',
  'src/self-improvement/training/master-preflight.cjs',
  'src/self-improvement/training/dataset-builder.cjs',
  'src/self-improvement/training/qlora-config.cjs',
  'src/self-improvement/training/lineage.cjs',
  'src/self-improvement/training/gpu-ownership.cjs',
  'src/self-improvement/training/runtime-resource-controller.cjs',
  'src/self-improvement/training/runtime-client.cjs',
  'src/self-improvement/training/training-runner.cjs',
  'src/self-improvement/training/nightly-training-session.cjs',
  'src/self-improvement/training/hf-rem-inference.cjs',
  'src/self-improvement/training/training-scheduler.cjs',
  'src/self-improvement/ui-status.cjs',
  'containers/self-improvement-training/Containerfile',
  'containers/self-improvement-training/train_qlora.py',
  'containers/self-improvement-training/rem_inference.py',
  'apps/floki-neural-interface/src/pages/RSILab.jsx',
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
];
for (const relative of requiredFiles) {
  assert.equal(fs.existsSync(path.join(ROOT, relative)), true, 'missing production file: ' + relative);
}

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.engines.node, '>=24');
const suite = String(pkg.scripts?.['test:node24'] || '');
const rsiTests = fs.readdirSync(path.join(ROOT, 'tests'))
  .filter((name) => /^rsi-.*-test\.cjs$/.test(name))
  .sort();
for (const test of rsiTests) {
  assert.equal(suite.includes('node tests/' + test), true, 'RSI contract absent from npm test: ' + test);
}

const scheduler = read('src/self-improvement/training/training-scheduler.cjs');
for (const marker of [
  'nightlyTrainingDecision','checkpointNightlyTraining','runHfRemGeneration',
  'finalizeNightlyTraining','manual_nap_ollama','wake_restoration'
]) assert.equal(scheduler.includes(marker), true, 'scheduler marker missing: ' + marker);
assert.equal(scheduler.includes('FLOKI_ALLOW_NIGHTLY_TRAINING'), false);

for (const [relative, markers] of Object.entries({
  'src/self-improvement/training/runtime-resource-controller.cjs': [
    'restoreRuntimeResources','restartKnowledge','FLOKI_TRAINING_RESOURCE_ENTER_FAILED'
  ],
  'src/self-improvement/training/training-runner.cjs': [
    'removeTrainingContainer','waitForTrainingContainerLaunch','training_cleanup_failed'
  ],
  'src/self-improvement/training/nightly-training-session.cjs': [
    'waitForDetachedContainerLaunch','nightly_training_segment_launch_failed',
    'FLOKI_NIGHTLY_TRAINING_CONTAINER_CLEANUP_FAILED',
    'FLOKI_V2_NIGHTLY_TRAINING_FINALIZATION_PLAN','finalization_plan'
  ],
  'src/self-improvement/training/hf-rem-inference.cjs': [
    'forceRemove','already_absent','FLOKI_HF_REM_CONTAINER_CLEANUP_FAILED'
  ],
  'src/self-improvement/training/lineage.cjs': [
    'FLOKI_ADAPTER_LINEAGE_READ_FAILED','readLineageManifest'
  ],
  'src/runtime/chat-local-runtime.cjs': [
    'restartKnowledgeAfterTraining','restartKnowledge: restartKnowledgeAfterTraining'
  ]
})) {
  const source = read(relative);
  for (const marker of markers) {
    assert.equal(source.includes(marker), true, relative + ' missing release marker: ' + marker);
  }
}
assert.equal(scheduler.includes('FLOKI_NIGHTLY_REM_UNSAFE_GPU_HANDOFF'), true);

const sleep = getSleepConfig('chat');
assert.equal(sleep.manual_nap_duration_minutes, 30);
assert.equal(sleep.manual_nap_rem_offset_minutes, 10);
assert.equal(sleep.manual_nap_max_rem_cycles, 2);

const panel = read('apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx');
for (const marker of [
  'Run now','Run training','Abort sandbox','Abort training','GPU owner',
  'Loaded models & lineage','REM coordination','Errors & restoration',
  'Confirm approve','Confirm deny','status?.ui_limits?.candidate_render_limit'
]) assert.equal(panel.includes(marker), true, 'control-center marker missing: ' + marker);
assert.equal(panel.includes('window.prompt'), false);
assert.equal(panel.includes('window.confirm'), false);
assert.equal(panel.includes('MAX_RENDERED_CANDIDATES'), false);

const lab = read('apps/floki-neural-interface/src/pages/RSILab.jsx');
assert.match(lab, /h-full min-h-0 flex flex-col overflow-hidden/);
assert.match(lab, /uiLimitsRef/);
assert.equal(lab.includes('setTimeout(poll, 2000)'), false);
assert.equal(lab.includes('slice(-3000)'), false);

const workflow = read('.github/workflows/node.js.yml');
for (const marker of [
  'node-version-file: .nvmrc','train_qlora.py','rem_inference.py',
  'npm run test:integration --prefix apps/floki-neural-interface','npm test'
]) assert.equal(workflow.includes(marker), true, 'CI marker missing: ' + marker);

const productionVerify = read('bin/floki-production-verify.sh');
for (const marker of [
  'rsi-stage8-yaml-runtime-authority-contract-test.cjs',
  'rsi-stage8-integration-release-gate-contract-test.cjs',
  'rsi-training-python-helper-contract-test.cjs',
  'rsi-training-runtime-resource-transaction-contract-test.cjs',
  'rsi-training-runtime-resource-compatibility-contract-test.cjs',
  'rsi-training-container-cleanup-contract-test.cjs',
  'rsi-hf-rem-container-cleanup-contract-test.cjs',
  'rsi-nightly-training-failure-rem-continuity-contract-test.cjs',
  'rsi-adapter-lineage-error-surfacing-contract-test.cjs',
  'rsi-nightly-finalization-resume-contract-test.cjs',
  'npm test','npm run build','test:integration',
  'FLOKI_RSI_STAGE8_PRODUCTION_VERIFY_PASS'
]) assert.equal(productionVerify.includes(marker), true, 'production verify marker missing: ' + marker);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_STAGE8_V9_RELEASE_CONTRACT_PASS',
  stages_integrated: [1,2,3,4,5,6,7,8],
  all_rsi_contracts_in_main_suite: true,
  yaml_authority_contract_separate: true,
  manual_nap_rem_offsets_minutes: [10,20],
  live_host_verification_pending: true
}, null, 2));
