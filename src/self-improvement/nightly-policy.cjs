'use strict';

const path = require('node:path');

const {
  getSleepWindowForDate,
  isWithinSleepWindow
} = require('../chat/sleep-cycle.cjs');
const {
  loadSelfImprovementConfig
} = require('./config.cjs');

function asDate(value) {
  if (
    value === undefined &&
    process.env.FLOKI_SLEEP_TEST_NOW
  ) {
    return new Date(
      process.env.FLOKI_SLEEP_TEST_NOW
    );
  }

  return value instanceof Date
    ? value
    : new Date(value === undefined ? Date.now() : value);
}

function evaluateNightlyPolicy(
  config = loadSelfImprovementConfig(),
  now = undefined
) {
  const observedAt = asDate(now);
  const scopedRuntimeRoot =
    config.nightly_policy_runtime_root;
  const productionScope = Boolean(
    !scopedRuntimeRoot ||
    !config.runtime_root ||
    path.resolve(config.runtime_root) ===
      path.resolve(scopedRuntimeRoot)
  );
  const active = Boolean(
    productionScope &&
    isWithinSleepWindow(observedAt)
  );
  const sleepWindow = getSleepWindowForDate(observedAt);
  const trainingProvider = String(
    config.nightly_training_provider || ''
  ).trim();
  const remProvider = String(
    config.nightly_rem_provider || ''
  ).trim();
  const chatProvider = String(
    config.nightly_chat_provider || ''
  ).trim();

  if (active) {
    if (config.nightly_chat_enabled !== true) {
      throw new Error(
        'FLOKI_NIGHTLY_CHAT_DISABLED: nighttime chat must stay available'
      );
    }

    if (
      !trainingProvider ||
      remProvider !== trainingProvider ||
      chatProvider !== trainingProvider
    ) {
      throw new Error(
        'FLOKI_NIGHTLY_PROVIDER_MISMATCH: chat, dreams, and training must share the configured nightly provider'
      );
    }
  }

  const codeSandboxAllowed = (
    !active ||
    config.nightly_code_sandbox_enabled === true
  );

  return Object.freeze({
    active,
    production_scope: productionScope,
    observed_at: observedAt.toISOString(),
    sleep_date: sleepWindow.sleep_date,
    sleep_window_start: sleepWindow.start_at,
    sleep_window_end: sleepWindow.end_at,
    nightly_provider: trainingProvider || null,
    chat_available: !active || config.nightly_chat_enabled === true,
    code_sandbox_allowed: codeSandboxAllowed,
    manual_training_allowed: !active,
    run_now_allowed: codeSandboxAllowed,
    run_now_block_reason: codeSandboxAllowed
      ? null
      : 'nightly_hf_cycle'
  });
}

function assertRunNowAllowed(
  config = loadSelfImprovementConfig(),
  now = undefined
) {
  const policy = evaluateNightlyPolicy(config, now);

  if (!policy.run_now_allowed) {
    const error = new Error(
      'FLOKI_RUN_NOW_BLOCKED_NIGHTLY_HF_CYCLE: Run Now is unavailable during the configured nightly HF chat, dream, and training cycle'
    );
    error.code = 'FLOKI_RUN_NOW_BLOCKED_NIGHTLY_HF_CYCLE';
    error.policy = policy;
    throw error;
  }

  return policy;
}

module.exports = {
  assertRunNowAllowed,
  evaluateNightlyPolicy
};
