'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);

const LIVE_COMMANDS = Object.freeze([
  'node tests/piper-speech-smoke-contract-test.cjs',
  'node tests/qwen-cognition-contract-test.cjs',
  'node tests/chat-growth-persistence-contract-test.cjs'
]);

function run() {
  const scripts = pkg.scripts || {};
  const portable = String(scripts['test:node24'] || '');
  const live = String(scripts['test:live:node24'] || '');

  assert.equal(
    scripts.test,
    'bash bin/floki-node24-run.sh npm run test:node24'
  );
  assert.equal(
    scripts['test:live'],
    'bash bin/floki-node24-run.sh npm run test:live:node24'
  );
  assert.equal(
    portable.includes('node tests/ci-test-profile-contract-test.cjs'),
    true
  );
  assert.equal(live.startsWith('npm run test:node24 && '), true);

  for (const command of LIVE_COMMANDS) {
    assert.equal(
      portable.includes(command),
      false,
      command + ' must not run in the portable npm test profile'
    );
    assert.equal(
      live.includes(command),
      true,
      command + ' must remain available in the live test profile'
    );
  }

  assert.equal(
    portable.includes('node tests/chat-toolchain-readiness-contract-test.cjs'),
    true
  );
  assert.equal(
    portable.includes('node tests/chat-mode-status-contract-test.cjs'),
    true
  );

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CI_TEST_PROFILE_CONTRACT_PASS',
    npm_test_is_portable: true,
    live_proofs_preserved: true,
    live_test_count: LIVE_COMMANDS.length,
    node_24_wrapper_preserved: true,
    chat_mode_only: true
  }, null, 2));
}

run();
