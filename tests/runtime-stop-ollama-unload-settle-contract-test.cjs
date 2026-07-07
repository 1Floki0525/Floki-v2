'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  waitForNoLoadedModels
} = require(
  '../src/self-improvement/training/ollama-control.cjs'
);

async function run() {
  let clock = 0;
  let queries = 0;
  const config = {
    ollama_unload_endpoints: 'http://127.0.0.1:11434',
    ollama_ps_path: '/api/ps',
    ollama_unload_timeout_ms: 1000,
    nightly_ollama_guard_poll_ms: 100
  };

  const settled = await waitForNoLoadedModels({
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    httpJson: async ({ method, url }) => {
      assert.equal(method, 'GET');
      assert.equal(url, 'http://127.0.0.1:11434/api/ps');
      queries += 1;
      return {
        ok: true,
        status: 200,
        json: {
          models: queries < 3
            ? [{ name: 'configured-test-model' }]
            : []
        }
      };
    }
  }, config);

  assert.equal(settled.ok, true);
  assert.equal(settled.attempts, 3);
  assert.deepEqual(settled.remaining, []);
  assert.equal(clock, 200);

  clock = 0;
  queries = 0;
  const timedOut = await waitForNoLoadedModels({
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    httpJson: async () => {
      queries += 1;
      return {
        ok: true,
        status: 200,
        json: {
          models: [{ model: 'still-resident-model' }]
        }
      };
    }
  }, {
    ...config,
    ollama_unload_timeout_ms: 250
  });

  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.attempts, 4);
  assert.deepEqual(timedOut.remaining, [{
    endpoint: 'http://127.0.0.1:11434',
    model: 'still-resident-model'
  }]);
  assert.equal(clock, 250);

  const runtimeScript = fs.readFileSync(
    path.join(ROOT, 'bin/floki-runtime.sh'),
    'utf8'
  );
  assert.match(runtimeScript, /waitForNoLoadedModels/);
  assert.match(
    runtimeScript,
    /configured Ollama models remain loaded after settlement deadline/
  );
  assert.doesNotMatch(
    runtimeScript,
    /for \(const endpoint of splitPipeList\(config\.ollama_unload_endpoints\)\)/
  );

  console.log(JSON.stringify({
    ok: true,
    marker:
      'FLOKI_RUNTIME_OLLAMA_UNLOAD_SETTLEMENT_CONTRACT_PASS',
    delayed_api_ps_eviction_accepted: true,
    timeout_remains_honest: true,
    yaml_timeout_used: true,
    yaml_poll_interval_used: true,
    runtime_started: false,
    model_loaded: false
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    marker:
      'FLOKI_RUNTIME_OLLAMA_UNLOAD_SETTLEMENT_CONTRACT_FAIL',
    error: error.message,
    stack: error.stack
  }, null, 2));
  process.exitCode = 1;
});
