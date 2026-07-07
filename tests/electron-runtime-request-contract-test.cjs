'use strict';

const assert =
  require('node:assert/strict');

const {
  createRuntimeRequest
} = require(
  '../apps/floki-neural-interface/' +
  'electron/runtime-request.cjs'
);
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  let calls = 0;

  const request =
    createRuntimeRequest({
      base_url:
        'http://127.0.0.1:7700',

      timeout_ms: 5000,

      fetch_impl:
        async (_url, options) => {
          calls += 1;

          assert.equal(
            options.headers.connection,
            'close'
          );

          if (calls === 1) {
            const error =
              new TypeError(
                'fetch failed'
              );

            error.cause =
              Object.assign(
                new Error(
                  'read ECONNRESET'
                ),
                {
                  code:
                    'ECONNRESET'
                }
              );

            throw error;
          }

          return new Response(
            '{"ok":true}',
            {
              status: 200
            }
          );
        }
    });

  const result =
    await request(
      'GET',
      '/interface/services'
    );

  assert.equal(
    result.ok,
    true
  );

  assert.equal(
    calls,
    2
  );

  let postCalls = 0;

  const post =
    createRuntimeRequest({
      base_url:
        'http://127.0.0.1:7700',

      timeout_ms: 5000,

      fetch_impl:
        async () => {
          postCalls += 1;

          const error =
            new TypeError(
              'fetch failed'
            );

          error.cause =
            Object.assign(
              new Error(
                'write EPIPE'
              ),
              {
                code: 'EPIPE'
              }
            );

          throw error;
        }
    });

  await assert.rejects(
    () => post(
      'POST',
      '/interface/control/requestSleep',
      {}
    ),
    /fetch failed/
  );

  assert.equal(
    postCalls,
    1
  );

  // Per-call timeout override: a slow response must survive the small default
  // timeout when a larger override is supplied, and be aborted without one.
  // This is what lets "Run Now" wait for a slow sandbox snapshot+start instead
  // of the UI aborting at the default stream timeout.
  const slowFetch = (delayMs) => (_url, options) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve(new Response('{"ok":true}', { status: 200 })),
        delayMs
      );
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(signal.reason || new Error('aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('aborted'));
          },
          { once: true }
        );
      }
    });

  const shortDefault = createRuntimeRequest({
    base_url: 'http://127.0.0.1:7700',
    timeout_ms: 50,
    fetch_impl: slowFetch(250)
  });

  let abortedAtDefault = false;
  try {
    await shortDefault('POST', '/self-improvement/run-now', { x: 1 });
  } catch (error) {
    abortedAtDefault =
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      /timeout|abort/i.test(String(error.message));
  }
  assert.equal(
    abortedAtDefault,
    true,
    'a slow request is aborted at the small default timeout'
  );

  const overrideResult = await shortDefault(
    'POST',
    '/self-improvement/run-now',
    { x: 1 },
    5000
  );
  assert.equal(
    overrideResult.ok,
    true,
    'a larger per-call timeout override lets the slow request complete'
  );

  const mainSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'apps/floki-neural-interface/electron/main.cjs'
    ),
    'utf8'
  );

  assert.match(
    mainSource,
    /ipcMain\.handle\('floki:open-log'[\s\S]*text:\s*String\(result\.text \|\| ''\)/
  );

  assert.doesNotMatch(
    mainSource,
    /shell\.openPath/
  );

  assert.doesNotMatch(
    mainSource,
    /shell\.showItemInFolder/,
    'Electron log opening must use in-app workspace content, not host filesystem openers'
  );

  // Run Now must use a client timeout derived from the server sandbox-start
  // budget, passed as the per-call override on the run-now request.
  assert.match(
    mainSource,
    /RUN_NOW_REQUEST_TIMEOUT_MS\s*=\s*\n?\s*Number\(selfImprovementConfig\.run_now_ack_timeout_ms\)/,
    'run-now client timeout must derive from run_now_ack_timeout_ms'
  );
  assert.match(
    mainSource,
    /run-self-improvement-now'[\s\S]*?\/self-improvement\/run-now'[\s\S]*?RUN_NOW_REQUEST_TIMEOUT_MS/,
    'run-now IPC handler must pass the per-call timeout override'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,

        marker:
          'FLOKI_V2_ELECTRON_' +
          'RUNTIME_REQUEST_' +
          'RECOVERY_PASS',

        idempotent_get_replayed_once:
          true,

        post_not_replayed:
          true,

        log_open_ipc_nonblocking:
          true,

        per_call_timeout_override:
          true,

        run_now_uses_extended_timeout:
          true,

        chat_mode_only:
          true,

        game_mode_started:
          false
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
