'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertRunNowAllowed,
  evaluateNightlyPolicy
} = require(
  '../src/self-improvement/nightly-policy.cjs'
);
const {
  loadSelfImprovementConfig
} = require(
  '../src/self-improvement/config.cjs'
);

const configured = loadSelfImprovementConfig();

for (const key of [
  'nightly_chat_enabled',
  'nightly_chat_provider',
  'nightly_chat_resume_training',
  'nightly_code_sandbox_enabled',
  'nightly_hf_operation_lock_file',
  'nightly_policy_runtime_root',
  'nightly_hf_operation_lock_timeout_ms',
  'nightly_hf_operation_lock_poll_ms'
]) {
  assert.notEqual(
    configured[key],
    undefined,
    'missing YAML authority key: ' + key
  );
}

const config = {
  nightly_training_provider: 'huggingface',
  nightly_rem_provider: 'huggingface',
  nightly_chat_provider: 'huggingface',
  nightly_chat_enabled: true,
  nightly_code_sandbox_enabled: false
};

const daytime = evaluateNightlyPolicy(
  config,
  new Date('2026-07-01T14:00:00-04:00')
);

assert.equal(daytime.active, false);
assert.equal(daytime.code_sandbox_allowed, true);
assert.equal(daytime.run_now_allowed, true);
assert.equal(daytime.chat_available, true);
assert.doesNotThrow(() => {
  assertRunNowAllowed(
    config,
    new Date('2026-07-01T14:00:00-04:00')
  );
});

const nighttime = evaluateNightlyPolicy(
  config,
  new Date('2026-07-01T23:30:00-04:00')
);

assert.equal(nighttime.active, true);
assert.equal(nighttime.nightly_provider, 'huggingface');
assert.equal(nighttime.chat_available, true);
assert.equal(nighttime.code_sandbox_allowed, false);
assert.equal(nighttime.manual_training_allowed, false);
assert.equal(nighttime.run_now_allowed, false);
assert.equal(
  nighttime.run_now_block_reason,
  'nightly_hf_cycle'
);

assert.throws(
  () => assertRunNowAllowed(
    config,
    new Date('2026-07-01T23:30:00-04:00')
  ),
  /FLOKI_RUN_NOW_BLOCKED_NIGHTLY_HF_CYCLE/
);

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(
  path.join(
    root,
    'src/self-improvement/worker.cjs'
  ),
  'utf8'
);
const promotion = fs.readFileSync(
  path.join(
    root,
    'src/self-improvement/promotion.cjs'
  ),
  'utf8'
);
const runtime = fs.readFileSync(
  path.join(
    root,
    'src/runtime/chat-local-runtime.cjs'
  ),
  'utf8'
);
const uiStatus = fs.readFileSync(
  path.join(
    root,
    'src/self-improvement/ui-status.cjs'
  ),
  'utf8'
);

assert.match(worker, /nightly_hf_cycle/);
assert.match(worker, /evaluateNightlyPolicy/);
assert.match(promotion, /assertRunNowAllowed/);
assert.match(runtime, /createNightlyHfChatPostJson/);
assert.match(runtime, /streaming_enabled:\s*nightlyHfChat/);
assert.match(uiStatus, /nightly_hf_cycle/);
assert.match(
  uiStatus,
  /nightlyPolicy\.run_now_allowed === true/
);
assert.match(
  uiStatus,
  /nightlyPolicy\.manual_training_allowed === true/
);
assert.match(
  uiStatus,
  /run_now_block_reason:\s*nightlyPolicy\.run_now_block_reason/
);

console.log(
  'FLOKI_NIGHTLY_HF_POLICY_CONTRACT_PASS'
);
