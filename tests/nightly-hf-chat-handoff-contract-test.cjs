'use strict';

const assert = require('node:assert/strict');

const {
  createNightlyHfChatPostJson
} = require(
  '../src/self-improvement/training/nightly-hf-chat.cjs'
);

(async () => {
  const transfers = [];
  const checkpoints = [];
  const starts = [];
  let owner = 'hf_training';
  let session = {
    run_id: 'nightly-run-one',
    sleep_date: '2026-07-01',
    current_container: 'training-segment-one',
    finalized: false,
    training_failed: false,
    resource_entered: true
  };

  const config = {
    nightly_chat_resume_training: true,
    nightly_chat_provider: 'huggingface',
    hf_rem_id_prefix: 'hf-rem',
    hf_rem_id_random_bytes: 2
  };

  const postJson = createNightlyHfChatPostJson({
    config,
    dependencies: {
      policy: () => ({
        active: true,
        chat_available: true
      }),
      now: () => new Date(
        '2026-07-01T23:30:00-04:00'
      ),
      withLock: async (kind, operation) => {
        assert.equal(kind, 'nightly_chat');
        return operation();
      },
      readSession: () => session,
      readSleepState: () => ({
        interrupted: false
      }),
      checkpoint: async (value, options) => {
        checkpoints.push({
          run_id: value.run_id,
          reason: options.reason
        });
        session = {
          ...value,
          current_container: null,
          latest_checkpoint: 'checkpoint-1'
        };
        return {
          ok: true,
          session
        };
      },
      gpu: {
        currentOwner: () => owner,
        transfer(from, to, detail) {
          assert.equal(owner, from);
          transfers.push({
            from,
            to,
            reason: detail.reason
          });
          owner = to;
          return { owner };
        },
        acquire(next) {
          assert.equal(owner, null);
          owner = next;
          return { owner };
        },
        release(current) {
          assert.equal(owner, current);
          owner = null;
          return true;
        }
      },
      runGeneration: (options) => {
        assert.equal(
          options.provider,
          config.nightly_chat_provider
        );
        assert.equal(
          options.prompt,
          'night chat prompt'
        );
        return {
          model: 'configured-hf-lineage',
          response_json: {
            response_intent_for_broca:
              'I am here with you.',
            safe_thought_summary:
              'I paused training to respond.',
            felt_interpretation:
              'I feel attentive.',
            memory_links: [],
            personality_implications: [],
            identity_implications: [],
            new_memory_summary:
              'I spoke during my night cycle.',
            emotion_reflection_enabled: true
          },
          raw_stats: {
            provider: 'huggingface'
          }
        };
      },
      setResourceEntered(value, entered) {
        session = {
          ...value,
          resource_entered: entered
        };
        return session;
      },
      startSegment: async (value) => {
        starts.push(value.run_id);
        session = {
          ...value,
          current_container: 'training-segment-two'
        };
        return session;
      }
    }
  });

  const response = await postJson(
    'unused://configured-nightly-hf',
    {
      prompt: 'night chat prompt',
      system: 'night chat system',
      format: {
        type: 'object'
      },
      options: {
        temperature: 0.5,
        top_p: 0.9,
        num_predict: 256
      }
    },
    {
      timeout_ms: 120000
    }
  );

  assert.equal(response.done, true);
  assert.equal(
    response.provider,
    config.nightly_chat_provider
  );
  assert.match(
    response.response,
    /I am here with you/
  );
  assert.deepEqual(checkpoints, [{
    run_id: 'nightly-run-one',
    reason: 'nightly_chat_handoff'
  }]);
  assert.deepEqual(transfers, [
    {
      from: 'hf_training',
      to: 'hf_rem_inference',
      reason: 'nightly_chat_handoff'
    },
    {
      from: 'hf_rem_inference',
      to: 'hf_training',
      reason: 'resume_after_nightly_chat'
    }
  ]);
  assert.deepEqual(starts, [
    'nightly-run-one'
  ]);
  assert.equal(
    session.current_container,
    'training-segment-two'
  );
  assert.equal(owner, 'hf_training');

  console.log(
    'FLOKI_NIGHTLY_HF_CHAT_HANDOFF_PASS'
  );
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
