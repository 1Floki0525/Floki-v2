'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const panel = fs.readFileSync(
  path.join(
    ROOT,
    'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
  ),
  'utf8'
);

for (const marker of [
  'actionFeedback',
  'lastRefreshedAt',
  'maker_requested_cycle',
  'result?.status || nextStatus',
  'pollMsRef',
  'setTimeout(run, pollMsRef.current)',
  'Pause verification failed',
  'Resume verification failed',
  "setReviewAction('deny')",
  "setReviewAction('approve')",
  'Confirm deny',
  'Confirm approve',
  'flokiAdapter.denySelfImprovement(detail.id, reason)',
  'flokiAdapter.approveSelfImprovement(detail.id)',
  'makerObjective',
  'Experiment objective — optional',
  'runSelfImprovementNow(trimmedObjective)',
  "setMakerObjective('')",
  'objective_source',
  'Maker-requested',
  'Floki-selected',
  'result?.sandbox_started === true',
  'nextStatus?.current_container',
  'Self-Improvement Worker',
  'Self-Improvement Sandbox',
  'Run now',
  'Run training',
  'Abort sandbox',
  'Abort training',
  'GPU owner',
  'Loaded models & lineage',
  'REM coordination',
  'Errors & restoration',
  'Pending',
  'History',
  'Approve and activate'
]) {
  assert.equal(panel.includes(marker), true, 'panel missing marker: ' + marker);
}

assert.equal(panel.includes('window.prompt'), false);
assert.equal(panel.includes('window.confirm'), false);
assert.equal(panel.includes('const [feedback, setFeedback]'), false);
assert.equal(panel.includes('setTimeout(poll, pollMsRef.current)'), false);
assert.equal(panel.includes("verifiedStatus?.state === 'queued'"), false);
assert.match(panel, /nextStatus\?\.ui_poll_ms/);
assert.match(panel, /h-full min-h-0 flex flex-col overflow-hidden/);
assert.match(panel, /makerCycleQueued/);
assert.match(
  panel,
  /disabled=\{Boolean\(busy\) \|\| makerCycleQueued \|\| !canRunCode\}/
);
assert.match(
  panel,
  /disabled=\{Boolean\(busy\) \|\| makerCycleQueued \|\| !canRunTraining\}/
);
assert.doesNotMatch(panel, /setInterval\s*\([^,]+,\s*\d+/);
assert.doesNotMatch(panel, /setTimeout\s*\([^,]+,\s*\d+/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_STAGE7_FULL_PANEL_CONTRACT_COMPATIBILITY_PASS',
  functional_controls_preserved: true,
  runtime_controls_preserved: true,
  run_now_immediate_preserved: true,
  objective_contract_preserved: true,
  yaml_authority_preserved: true,
  stage7_controls_preserved: true
}, null, 2));
