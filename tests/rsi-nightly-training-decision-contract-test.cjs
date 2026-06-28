'use strict';

const assert = require('node:assert/strict');
const {
  automaticTrainingEnabled,
  nightlyTrainingDecision
} = require('../src/self-improvement/training/training-scheduler.cjs');

const config = {
  training_enabled: true,
  nightly_training_enabled: true
};

assert.equal(
  automaticTrainingEnabled(config),
  true
);
assert.equal(
  automaticTrainingEnabled({ ...config, nightly_training_enabled: false }),
  false,
  'automatic training must obey the authoritative nightly_training_enabled YAML toggle'
);

assert.deepEqual(
  nightlyTrainingDecision({
    enabled: true,
    within_sleep_window: true,
    manual_nap_active: false
  }),
  {
    action: 'nightly_training',
    train_now: true,
    pause_for_manual_nap: false,
    restore_for_wake: false
  }
);

assert.equal(
  nightlyTrainingDecision({
    enabled: true,
    within_sleep_window: true,
    manual_nap_active: true
  }).action,
  'manual_nap_ollama'
);
assert.equal(
  nightlyTrainingDecision({
    enabled: true,
    within_sleep_window: false,
    manual_nap_active: false
  }).action,
  'wake_restoration'
);
assert.equal(
  nightlyTrainingDecision({
    enabled: false,
    within_sleep_window: true,
    manual_nap_active: false
  }).action,
  'disabled'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_RSI_NIGHTLY_TRAINING_DECISION_PASS',
  nightly_only: true,
  manual_nap_uses_ollama: true,
  wake_restoration_required: true
}, null, 2));
