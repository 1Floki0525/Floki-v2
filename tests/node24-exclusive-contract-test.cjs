'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_LATENCY_TESTS = Object.freeze([
  'tests/ollama-streaming-transport-contract-test.cjs',
  'tests/public-response-stream-contract-test.cjs',
  'tests/latency-trace-privacy-contract-test.cjs',
  'tests/latency-integration-source-contract-test.cjs',
  'tests/frontal-stream-repair-source-contract-test.cjs',
  'tests/hearing-bridge-release-gate-scope-contract-test.cjs'
]);

function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(pkg.scripts.test, 'bash bin/floki-node24-run.sh npm run test:node24');
  assert.equal(typeof pkg.scripts['test:node24'], 'string');
  assert.equal(pkg.scripts['test:node24'].includes('bin/floki-node24-run.sh'), false);

  for (const relative of REQUIRED_LATENCY_TESTS) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, relative + ' must exist');
    assert.equal(pkg.scripts['test:node24'].includes('node ' + relative), true, relative + ' must run in npm test');
  }

  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '24');
  assert.equal(fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim(), '24');

  const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8').split(/\r?\n/);
  assert.equal(npmrc.includes('engine-strict=true'), true);

  const wrapper = fs.readFileSync(path.join(ROOT, 'bin', 'floki-node24-run.sh'), 'utf8');
  assert.equal(wrapper.includes('nvm use 24'), true);
  assert.equal(wrapper.includes('requires Node 24 exclusively'), true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_NODE24_EXCLUSIVE_CONTRACT_PASS',
    node_version: process.version,
    engine_range: pkg.engines.node,
    npm_test_uses_node24_wrapper: true,
    latency_tests_in_full_suite: true,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: 'FLOKI_V2_NODE24_EXCLUSIVE_CONTRACT_FAIL',
    error: error.message,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
  process.exit(1);
}
