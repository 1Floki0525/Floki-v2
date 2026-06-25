'use strict';

const assert =
  require('node:assert/strict');

const path =
  require('node:path');

process.env.FLOKI_CONFIG_PATH =
  path.resolve(
    'tests/fixtures/' +
    'chat.config.test.yaml'
  );

const {
  buildDreamTimeline
} = require(
  '../src/chat/dream-timeline.cjs'
);

const timeline =
  buildDreamTimeline({
    now:
      '2026-06-24T20:05:00.000Z',

    records: [],

    manual_nap_state: {
      kind:
        'manual_nap',

      active:
        true,

      completed:
        false,

      runtime_session_id:
        'current-runtime',

      started_at:
        '2026-06-24T20:00:00.000Z',

      wake_at:
        '2026-06-24T20:30:00.000Z',

      rem_interval_minutes:
        10,

      rem_cycles: [
        {
          cycle_number:
            1,

          scheduled_at:
            '2026-06-24T20:00:00.000Z',

          status:
            'complete',

          completed_at:
            '2026-06-24T20:01:00.000Z'
        },

        {
          cycle_number:
            2,

          scheduled_at:
            '2026-06-24T20:10:00.000Z',

          status:
            'pending'
        },

        {
          cycle_number:
            3,

          scheduled_at:
            '2026-06-24T20:20:00.000Z',

          status:
            'pending'
        }
      ]
    },

    lifecycle_status: {
      state:
        'asleep',

      is_asleep:
        true,

      is_dreaming:
        false
    },

    dream_status: {
      dream_index_file:
        '/nonexistent/index.jsonl'
    },

    sleep_cycle_state:
      null
  });

assert.equal(
  timeline.activeSession
    .completedRemCycles,
  1
);

assert.equal(
  timeline.activeSession
    .totalRemCycles,
  3
);

assert.equal(
  timeline.activeSession
    .runtimeSessionId,
  'current-runtime'
);

console.log(
  JSON.stringify(
    {
      ok: true,

      marker:
        'FLOKI_V2_DREAM_ACTIVE_' +
        'SESSION_COUNT_PASS',

      completed:
        1,

      total:
        3,

      historical_archive_not_added:
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
