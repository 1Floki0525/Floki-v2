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
    /ipcMain\.handle\('floki:open-log'[\s\S]*shell\.showItemInFolder\(result\.path\)/
  );

  assert.match(
    mainSource,
    /void shell\.openPath\(result\.path\)/
  );

  assert.doesNotMatch(
    mainSource,
    /await shell\.openPath\(result\.path\)/,
    'log opening must not block the IPC reply on desktop opener completion'
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
