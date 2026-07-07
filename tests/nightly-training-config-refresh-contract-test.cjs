'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const sessionSource = fs.readFileSync(
  path.join(
    root,
    'src/self-improvement/training/nightly-training-session.cjs'
  ),
  'utf8'
);
const schedulerSource = fs.readFileSync(
  path.join(
    root,
    'src/self-improvement/training/training-scheduler.cjs'
  ),
  'utf8'
);

assert.match(
  sessionSource,
  /trainingConfigFingerprint/
);
assert.match(
  sessionSource,
  /delete normalized\.training\.num_train_epochs/
);
assert.match(
  sessionSource,
  /delete normalized\.scheduler\.segment_number/
);
assert.match(
  sessionSource,
  /training_config_sha256/
);
assert.match(
  sessionSource,
  /failedConfigUnchanged/
);
assert.match(
  sessionSource,
  /retryingAfterConfigChange/
);
assert.match(
  sessionSource,
  /retried_after_config_change/
);
assert.match(
  sessionSource,
  /buildTrainingConfig\(\{\s*config\s*\}\)/
);
assert.match(
  sessionSource,
  /metricsHaveTraining\(artifactDir,\s*config,\s*current\)/
);
assert.match(
  schedulerSource,
  /loadFreshSelfImprovementConfig/
);
assert.match(
  schedulerSource,
  /config:\s*deps\.loadConfig\(\)/
);
assert.match(
  schedulerSource,
  /nightly_training_already_finalized/
);
assert.match(
  schedulerSource,
  /nightly_chat_interruption/
);
// Training resumption after a night chat interruption re-enters through the
// standard epoch-boundary launch (commit 75aa7a0 removed the dedicated
// resume_after_night_chat_idle transfer detail).
assert.match(
  schedulerSource,
  /start_next_complete_epoch/
);

console.log(
  'FLOKI_NIGHTLY_TRAINING_CONFIG_REFRESH_PASS'
);
