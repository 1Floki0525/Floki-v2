'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const text = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// Contract updated 2026-07-04: RSILab replaced the dual structured/raw poll
// loops with a single raw read-only terminal poll. The preserved invariants
// are behavioral: requests never overlap (the next poll is scheduled only
// after the previous one settles), responses are never applied after unmount,
// source switches reset the cursor, and older output loads by before_cursor.
const rsiLab = text('apps/floki-neural-interface/src/pages/RSILab.jsx');
for (const snippet of [
  'if (stopped) return;',
  'stopped = true;',
  'clearTimeout(timer)',
  'before_cursor: current.startCursor'
]) {
  assert.ok(rsiLab.includes(snippet), 'RSILab missing polling invariant: ' + snippet);
}
assert.match(
  rsiLab,
  /finally\s*\{\s*if \(!stopped\) timer = setTimeout\(poll, terminalPollMs\(uiLimitsRef\.current\)\);/,
  'the next poll must be scheduled only after the previous request settles, at the YAML-driven cadence'
);
assert.match(
  rsiLab,
  /payload\.source_id !== current\.sourceId/,
  'a source switch must reset the terminal cursor'
);
assert.doesNotMatch(rsiLab, /const activeRef = useRef\(false\)/);
assert.doesNotMatch(
  rsiLab,
  /getSelfImprovementActivity/,
  'RSILab must poll the raw terminal, not the structured activity feed'
);

const adapter = text('apps/floki-neural-interface/src/integrations/floki/adapter.js');
assert.match(adapter, /getSelfImprovementActivity\(params = \{\}\)/);
assert.match(adapter, /signal:\s*params\.signal/);
assert.match(adapter, /getSelfImprovementTerminal\(params = \{\}\)/);

const runtime = text('src/runtime/chat-local-runtime.cjs');
assert.match(runtime, /function rsiRunIdFromLogFile/);
assert.match(runtime, /const displayRunId =[\s\S]+rsiRunIdFromLogFile\(lastSandboxLogFile, rsiConfig\)/);
assert.match(runtime, /run_id:\s*displayRunId/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_TERMINAL_POLLING_CONTRACT_PASS',
  abortable_polling: true,
  completed_run_identity: true
}, null, 2));
