'use strict';

const assert = require('node:assert/strict');
const {
  resolveNightlyProviders
} = require('../src/self-improvement/training/training-scheduler.cjs');

const focusedInjectedConfig = resolveNightlyProviders({
  nightly_rem_provider: 'huggingface'
});
assert.equal(
  focusedInjectedConfig.nightly_rem_provider,
  'huggingface'
);
assert.equal(
  focusedInjectedConfig.nightly_training_provider,
  'huggingface'
);
assert.equal(
  focusedInjectedConfig.injected_training_provider_defaulted,
  true
);

const productionConfig = resolveNightlyProviders({
  nightly_rem_provider: 'huggingface',
  nightly_training_provider: 'huggingface'
});
assert.equal(
  productionConfig.injected_training_provider_defaulted,
  false
);

assert.throws(
  () => resolveNightlyProviders({
    nightly_rem_provider: 'huggingface',
    nightly_training_provider: 'ollama'
  }),
  /FLOKI_NIGHTLY_REM_PROVIDER_INVALID/
);

assert.throws(
  () => resolveNightlyProviders({
    nightly_training_provider: 'huggingface'
  }),
  /nightly_rem_provider is required/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_NIGHTLY_PROVIDER_COMPATIBILITY_PASS',
  production_yaml_requires_both: true,
  focused_injected_config_compatible: true,
  explicit_mismatch_rejected: true
}, null, 2));
