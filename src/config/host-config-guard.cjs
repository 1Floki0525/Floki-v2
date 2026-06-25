'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('./floki-config.cjs');

const PROTECTED_PATH_KEYS = Object.freeze([
  'state_root',
  'tool_input_root',
  'tool_output_root',
  'runtime_root',
  'chat_runtime_root',
  'chat_transcript_root',
  'dream_root',
  'media_root',
  'youtube_transcript_root',
  'youtube_cookies_file'
]);

const DEFAULT_MANIFEST_FILE = path.join(
  os.homedir(),
  '.config',
  'floki-v2',
  'chat-config-protected-paths.json'
);

function canonical(value) {
  const expanded = String(value || '').replace(/^~(?=\/)/, os.homedir());
  return path.resolve(PROJECT_ROOT, expanded);
}

function protectedPaths(paths = getPathConfig('chat')) {
  const result = {};
  for (const key of PROTECTED_PATH_KEYS) {
    if (typeof paths[key] === 'string' && paths[key].trim()) {
      result[key] = canonical(paths[key]);
    }
  }
  return Object.freeze(result);
}

function assertNoCiFixturePaths(paths) {
  for (const [key, value] of Object.entries(paths)) {
    if (value.includes('/floki-v2-ci/') || value.endsWith('/floki-v2-ci')) {
      throw new Error(`HOST_CONFIG_CI_PATH_REJECTED: ${key}=${value}`);
    }
  }
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || !value.paths || typeof value.paths !== 'object') {
    throw new Error(`HOST_CONFIG_MANIFEST_INVALID: ${file}`);
  }
  return value;
}

function initializeHostConfigManifest(options = {}) {
  const manifestFile = path.resolve(options.manifest_file || process.env.FLOKI_HOST_CONFIG_MANIFEST || DEFAULT_MANIFEST_FILE);
  const paths = protectedPaths(options.paths || getPathConfig('chat'));
  assertNoCiFixturePaths(paths);
  const value = {
    version: 1,
    project_root: PROJECT_ROOT,
    initialized_at: new Date().toISOString(),
    paths
  };
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const temp = manifestFile + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, manifestFile);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_HOST_CONFIG_MANIFEST_INITIALIZED',
    manifest_file: manifestFile,
    paths
  });
}

function assertHostConfigSafe(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV !== 'test' && env.CI !== 'true' && env.GITHUB_ACTIONS !== 'true' && env.FLOKI_ALLOW_TEMP_CONFIG !== '1';
  const current = protectedPaths(options.paths || getPathConfig('chat'));
  assertNoCiFixturePaths(current);

  if (!production) {
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_HOST_CONFIG_PROTECTION_PASS',
      production: false,
      paths: current
    });
  }

  const manifestFile = path.resolve(options.manifest_file || env.FLOKI_HOST_CONFIG_MANIFEST || DEFAULT_MANIFEST_FILE);
  const manifest = options.manifest || readManifest(manifestFile);
  if (!manifest) {
    throw new Error(`HOST_CONFIG_MANIFEST_MISSING: ${manifestFile}`);
  }

  const expected = protectedPaths(manifest.paths);
  for (const key of PROTECTED_PATH_KEYS) {
    const before = expected[key] || null;
    const now = current[key] || null;
    if (before !== now) {
      throw new Error(`HOST_CONFIG_PATH_DRIFT_REJECTED: ${key}: expected ${before}, got ${now}`);
    }
  }

  if (!current.dream_root || !fs.existsSync(current.dream_root)) {
    throw new Error(`HOST_CONFIG_DREAM_ROOT_MISSING: ${current.dream_root || 'undefined'}`);
  }

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_HOST_CONFIG_PROTECTION_PASS',
    production: true,
    manifest_file: manifestFile,
    paths: current,
    host_config_owned: true,
    active_config_never_replaced_by_test_template: true
  });
}

if (require.main === module) {
  try {
    const result = process.argv.includes('--initialize')
      ? initializeHostConfigManifest()
      : assertHostConfigSafe();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_HOST_CONFIG_PROTECTION_FAIL',
      error: error && error.message ? error.message : String(error)
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  PROTECTED_PATH_KEYS,
  DEFAULT_MANIFEST_FILE,
  protectedPaths,
  initializeHostConfigManifest,
  assertHostConfigSafe
};
