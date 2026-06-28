'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const panel = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'),
  'utf8'
);
const lab = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/src/pages/RSILab.jsx'),
  'utf8'
);
const adapter = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/src/integrations/floki/adapter.js'),
  'utf8'
);
const preload = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/electron/preload.cjs'),
  'utf8'
);
const main = fs.readFileSync(
  path.join(ROOT, 'apps/floki-neural-interface/electron/main.cjs'),
  'utf8'
);
const runtime = fs.readFileSync(
  path.join(ROOT, 'src/runtime/chat-local-runtime.cjs'),
  'utf8'
);

for (const text of [
  'Run now',
  'Run training',
  'Abort training',
  'Abort sandbox',
  'GPU owner',
  'Loaded models & lineage',
  'REM coordination',
  'Errors & restoration',
  'Pending',
  'History',
  'Approve and activate',
  'Confirm approve',
  'Confirm deny'
]) {
  assert.equal(panel.includes(text), true, 'panel missing: ' + text);
}

assert.equal(panel.includes('window.prompt'), false);
assert.equal(panel.includes('window.confirm'), false);
assert.match(panel, /h-full min-h-0 flex flex-col overflow-hidden/);
assert.match(lab, /flex-\[3\] min-h-0 overflow-hidden/);
assert.match(adapter, /runSelfImprovementNow\(objective = '', kind = 'code'\)/);
assert.match(adapter, /abortSelfImprovement/);
assert.match(preload, /runSelfImprovementNow: \(objective = '', kind = 'code'\)/);
assert.match(preload, /abortSelfImprovement/);
assert.match(main, /kind: String\(payload\.kind \|\| 'code'\)/);
assert.match(main, /floki:abort-self-improvement/);
assert.match(runtime, /\/self-improvement\/abort/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_STAGE7_RSI_CONTROL_CENTER_SOURCE_PASS',
  fixed_viewport: true,
  separate_run_controls: true,
  abort_controls: true,
  inline_review_controls: true
}, null, 2));
