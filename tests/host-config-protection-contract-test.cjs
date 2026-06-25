'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  initializeHostConfigManifest,
  assertHostConfigSafe
} = require('../src/config/host-config-guard.cjs');
const { prepareCiConfig } = require('../bin/floki-prepare-ci-config.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-host-guard-'));
const manifest = path.join(root, 'manifest.json');
const paths = {
  state_root: path.join(root, 'state'),
  chat_runtime_root: path.join(root, 'runtime'),
  dream_root: path.join(root, 'dreams'),
  media_root: path.join(root, 'media'),
  youtube_transcript_root: path.join(root, 'transcripts'),
  youtube_cookies_file: path.join(root, 'cookies.txt')
};
fs.mkdirSync(paths.dream_root, { recursive: true });
initializeHostConfigManifest({ manifest_file: manifest, paths });
assert.equal(assertHostConfigSafe({ manifest_file: manifest, paths, env: {} }).ok, true);
assert.throws(
  () => assertHostConfigSafe({ manifest_file: manifest, paths: { ...paths, dream_root: path.join(root, 'other-dreams') }, env: {} }),
  /HOST_CONFIG_PATH_DRIFT_REJECTED/
);
assert.throws(
  () => assertHostConfigSafe({ manifest_file: manifest, paths: { ...paths, dream_root: '/tmp/floki-v2-ci/Floki-memory-bank/dreams' }, env: {} }),
  /HOST_CONFIG_CI_PATH_REJECTED/
);
const oldCi = process.env.CI;
const oldActions = process.env.GITHUB_ACTIONS;
delete process.env.CI;
delete process.env.GITHUB_ACTIONS;
try {
  assert.throws(
    () => prepareCiConfig(),
    /HOST_CONFIG_OVERWRITE_BLOCKED/
  );
} finally {
  if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
  if (oldActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldActions;
}
fs.rmSync(root, { recursive: true, force: true });
console.log('FLOKI_V2_HOST_CONFIG_PROTECTION_CONTRACT_PASS');
