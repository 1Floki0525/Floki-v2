'use strict';

const assert = require('node:assert/strict');
const { filterActivityEventsForRun } = require('../src/runtime/chat-local-runtime.cjs');

const current = {
  source: 'sandbox',
  record: {
    type: 'implementation_started',
    detail: {
      run_id: 'rsi-current',
      experiment: { objective: 'current objective' }
    }
  }
};
const old = {
  source: 'sandbox',
  record: {
    type: 'implementation_started',
    detail: {
      run_id: 'rsi-old',
      experiment: { objective: 'old objective' }
    }
  }
};
const legacy = {
  source: 'sandbox',
  record: {
    type: 'sandbox_output',
    detail: { text: 'legacy unscoped output from the active log' }
  }
};

const filtered = filterActivityEventsForRun([old, current, legacy], 'rsi-current');
assert.deepEqual(filtered, [current, legacy]);
assert.deepEqual(filterActivityEventsForRun([old, current], null), []);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_ACTIVITY_RUN_FILTER_PASS',
  stale_implementation_filtered: true,
  current_run_preserved: true,
  idle_replay_suppressed: true
}, null, 2));
