'use strict';

const assert =
  require('node:assert/strict');

const fs =
  require('node:fs');

const os =
  require('node:os');

const path =
  require('node:path');

process.env.FLOKI_CONFIG_PATH =
  path.resolve(
    'tests/fixtures/' +
    'chat.config.test.yaml'
  );

const {
  beginManualNap,
  claimDueRemCycle,
  finishRemCycle
} = require(
  '../src/chat/manual-nap.cjs'
);

const sleep = {
  manual_nap_duration_minutes: 30,
  rem_interval_minutes: 10,
  manual_nap_rem_offset_minutes: 0,
  manual_nap_max_rem_cycles: 3,
  manual_nap_dream_max_retry_count: 3
};

const directory =
  fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      'floki-nap-session-'
    )
  );

const stateFile =
  path.join(
    directory,
    'state.json'
  );

try {
  beginManualNap({
    state_file:
      stateFile,

    sleep_config:
      sleep,

    now:
      '2026-06-24T20:00:00.000Z',

    runtime_session_id:
      'old-runtime',

    replace_active:
      true
  });

  claimDueRemCycle({
    state_file:
      stateFile,

    sleep_config:
      sleep,

    now:
      '2026-06-24T20:00:00.100Z'
  });

  finishRemCycle(
    {
      dream_txt_file:
        '/tmp/old-dream.txt'
    },
    null,
    {
      state_file:
        stateFile,

      sleep_config:
        sleep,

      dream_config:
        {},

      now:
        '2026-06-24T20:00:10.000Z'
    }
  );

  const fresh =
    beginManualNap({
      state_file:
        stateFile,

      sleep_config:
        sleep,

      now:
        '2026-06-24T20:02:00.000Z',

      runtime_session_id:
        'new-runtime',

      replace_active:
        true,

      consolidation: {
        ok: true
      }
    });

  assert.equal(
    fresh.runtime_session_id,
    'new-runtime'
  );

  assert.equal(
    fresh.rem_cycles.length,
    3
  );

  assert.deepEqual(
    fresh.rem_cycles.map(
      (cycle) => cycle.status
    ),
    [
      'pending',
      'pending',
      'pending'
    ]
  );

  assert.equal(
    fresh.rem_cycles.some(
      (cycle) =>
        cycle.dream_txt_file ===
        '/tmp/old-dream.txt'
    ),
    false
  );

  const same =
    beginManualNap({
      state_file:
        stateFile,

      sleep_config:
        sleep,

      now:
        '2026-06-24T20:02:01.000Z',

      runtime_session_id:
        'new-runtime',

      replace_active:
        true
    });

  assert.equal(
    same.started_at,
    fresh.started_at
  );

  console.log(
    JSON.stringify(
      {
        ok: true,

        marker:
          'FLOKI_V2_MANUAL_NAP_' +
          'SESSION_ISOLATION_PASS',

        previous_cycle_not_merged:
          true,

        current_cycles:
          3,

        chat_mode_only:
          true,

        game_mode_started:
          false
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(
    directory,
    {
      recursive: true,
      force: true
    }
  );
}
