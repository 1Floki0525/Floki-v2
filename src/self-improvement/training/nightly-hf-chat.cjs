'use strict';

const crypto = require('node:crypto');

const {
  loadSleepCycleState
} = require('../../chat/sleep-cycle.cjs');
const {
  loadFreshSelfImprovementConfig,
  loadSelfImprovementConfig
} = require('../config.cjs');
const {
  evaluateNightlyPolicy
} = require('../nightly-policy.cjs');
const gpuOwnership = require('./gpu-ownership.cjs');
const {
  checkpointNightlyTraining,
  readNightlySession,
  setSessionResourceEntered,
  startNightlyTrainingSegment
} = require('./nightly-training-session.cjs');
const {
  runHfRemGeneration
} = require('./hf-rem-inference.cjs');
const {
  withNightlyHfOperationLock
} = require('./nightly-hf-operation-lock.cjs');

function makeNightChatId(config) {
  if (
    !config.hf_rem_id_prefix ||
    !Number.isInteger(
      Number(config.hf_rem_id_random_bytes)
    )
  ) {
    throw new Error(
      'configured HF inference ID settings are missing'
    );
  }

  return (
    String(config.hf_rem_id_prefix) +
    '-chat-' +
    new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) +
    '-' +
    crypto.randomBytes(
      Number(config.hf_rem_id_random_bytes)
    ).toString('hex')
  );
}

function normalizeGenerationOptions(
  payload = {},
  requestOptions = {}
) {
  const modelOptions = payload.options || {};

  return Object.freeze({
    prompt: String(payload.prompt || ''),
    system: String(payload.system || ''),
    schema:
      payload.format &&
      typeof payload.format === 'object'
        ? payload.format
        : null,
    temperature:
      typeof modelOptions.temperature === 'number'
        ? modelOptions.temperature
        : undefined,
    top_p:
      typeof modelOptions.top_p === 'number'
        ? modelOptions.top_p
        : undefined,
    max_new_tokens:
      typeof modelOptions.num_predict === 'number'
        ? modelOptions.num_predict
        : undefined,
    timeout_ms:
      typeof requestOptions.timeout_ms === 'number'
        ? requestOptions.timeout_ms
        : undefined,
    signal: requestOptions.signal
  });
}

function ollamaCompatibleEnvelope(result, provider) {
  if (
    !result ||
    !result.response_json ||
    typeof result.response_json !== 'object'
  ) {
    throw new Error(
      'FLOKI_NIGHTLY_HF_CHAT_RESPONSE_INVALID'
    );
  }

  return Object.freeze({
    model: result.model || null,
    created_at: new Date().toISOString(),
    response: JSON.stringify(result.response_json),
    done: true,
    done_reason: 'stop',
    total_duration:
      result.raw_stats?.total_duration ?? null,
    load_duration:
      result.raw_stats?.load_duration ?? null,
    prompt_eval_count:
      result.raw_stats?.prompt_eval_count ?? null,
    prompt_eval_duration:
      result.raw_stats?.prompt_eval_duration ?? null,
    eval_count:
      result.raw_stats?.eval_count ?? null,
    eval_duration:
      result.raw_stats?.eval_duration ?? null,
    provider
  });
}

function defaultDependencies() {
  return Object.freeze({
    policy: evaluateNightlyPolicy,
    gpu: gpuOwnership,
    checkpoint: checkpointNightlyTraining,
    readSession: readNightlySession,
    readSleepState: loadSleepCycleState,
    setResourceEntered: setSessionResourceEntered,
    startSegment: startNightlyTrainingSegment,
    runGeneration: runHfRemGeneration,
    withLock: withNightlyHfOperationLock,
    now: () => new Date()
  });
}


function nightlyHfModelConfig(
  config = loadFreshSelfImprovementConfig(),
  fallback = {}
) {
  return Object.freeze({
    provider: config.nightly_chat_provider,
    model: config.hf_rem_master_identity,
    endpoint: config.hf_rem_inference_endpoint,
    enabled_now: true,
    mode_scope: 'nightly_chat',
    temperature: fallback.temperature,
    top_p: fallback.top_p,
    timeout_ms: fallback.timeout_ms,
    keep_alive: fallback.keep_alive,
    allow_thinking: false,
    expose_private_reasoning: false,
    store_raw_private_reasoning: false
  });
}

function createNightlyHfChatPostJson(options = {}) {
  const deps = Object.freeze({
    ...defaultDependencies(),
    ...(options.dependencies || {})
  });

  return async function nightlyHfChatPostJson(
    _endpoint,
    payload,
    requestOptions = {}
  ) {
    const config =
      options.config ||
      loadFreshSelfImprovementConfig();

    return deps.withLock(
      'nightly_chat',
      async () => {
        const policy = deps.policy(
          config,
          deps.now()
        );

        if (
          policy.active !== true ||
          policy.chat_available !== true
        ) {
          throw new Error(
            'FLOKI_NIGHTLY_HF_CHAT_OUTSIDE_ACTIVE_WINDOW'
          );
        }

        if (
          requestOptions.signal &&
          requestOptions.signal.aborted
        ) {
          const error = new Error(
            'nightly HF chat request aborted'
          );
          error.name = 'AbortError';
          throw error;
        }

        let session = deps.readSession(config);
        let primaryError = null;

        try {
          if (session && session.current_container) {
            const checkpoint = await deps.checkpoint(
              session,
              {
                config,
                reason: 'nightly_chat_handoff'
              }
            );

            if (
              !checkpoint ||
              checkpoint.ok !== true
            ) {
              throw new Error(
                'FLOKI_NIGHTLY_CHAT_CHECKPOINT_FAILED: ' +
                String(
                  checkpoint?.error ||
                  'checkpoint did not return ok'
                )
              );
            }

            session = checkpoint.session || session;
          }

          const owner = deps.gpu.currentOwner(config);

          if (owner === 'hf_training') {
            deps.gpu.transfer(
              'hf_training',
              'hf_rem_inference',
              {
                reason: 'nightly_chat_handoff',
                run_id: session?.run_id || null
              },
              config
            );
          } else if (owner === null) {
            deps.gpu.acquire(
              'hf_rem_inference',
              {
                reason: 'nightly_chat_handoff',
                run_id: session?.run_id || null
              },
              config
            );
          } else if (owner !== 'hf_rem_inference') {
            throw new Error(
              'FLOKI_NIGHTLY_CHAT_GPU_OWNER_INVALID: ' +
              owner
            );
          }

          const generationOptions =
            normalizeGenerationOptions(
              payload,
              requestOptions
            );

          const result = await Promise.resolve(
            deps.runGeneration({
              config,
              rem_id: makeNightChatId(config),
              prompt: generationOptions.prompt,
              system: generationOptions.system,
              schema: generationOptions.schema,
              temperature:
                generationOptions.temperature,
              top_p: generationOptions.top_p,
              max_new_tokens:
                generationOptions.max_new_tokens,
              timeout_ms:
                generationOptions.timeout_ms,
              signal: generationOptions.signal,
              provider:
                config.nightly_chat_provider
            })
          );

          return ollamaCompatibleEnvelope(
            result,
            config.nightly_chat_provider
          );
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          try {
            const latest =
              deps.readSession(config) || session;
            const afterPolicy = deps.policy(
              config,
              deps.now()
            );
            const sleepState =
              deps.readSleepState();
            const chatInterruptionActive = Boolean(
              sleepState &&
              sleepState.interrupted === true
            );
            const shouldResume = Boolean(
              config.nightly_chat_resume_training === true &&
              afterPolicy.active === true &&
              chatInterruptionActive !== true &&
              latest &&
              latest.finalized !== true &&
              latest.training_failed !== true
            );
            const keepForNightConversation = Boolean(
              afterPolicy.active === true &&
              chatInterruptionActive === true
            );
            const currentOwner =
              deps.gpu.currentOwner(config);

            if (shouldResume) {
              if (
                currentOwner === 'hf_rem_inference'
              ) {
                deps.gpu.transfer(
                  'hf_rem_inference',
                  'hf_training',
                  {
                    reason:
                      'resume_after_nightly_chat',
                    run_id: latest.run_id
                  },
                  config
                );
              } else if (currentOwner === null) {
                deps.gpu.acquire(
                  'hf_training',
                  {
                    reason:
                      'resume_after_nightly_chat',
                    run_id: latest.run_id
                  },
                  config
                );
              } else if (
                currentOwner !== 'hf_training'
              ) {
                throw new Error(
                  'FLOKI_NIGHTLY_CHAT_RESUME_GPU_OWNER_INVALID: ' +
                  currentOwner
                );
              }

              const resourceReady =
                deps.setResourceEntered(
                  latest,
                  true,
                  config
                );

              await deps.startSegment(
                resourceReady,
                { config }
              );
            } else if (
              !keepForNightConversation &&
              currentOwner === 'hf_rem_inference'
            ) {
              deps.gpu.release(
                'hf_rem_inference',
                config
              );
            }
          } catch (resumeError) {
            if (primaryError) {
              primaryError.message +=
                '\nnightly training resume failed: ' +
                resumeError.message;
            } else {
              throw resumeError;
            }
          }
        }
      },
      config
    );
  };
}

module.exports = {
  createNightlyHfChatPostJson,
  nightlyHfModelConfig,
  makeNightChatId,
  normalizeGenerationOptions,
  ollamaCompatibleEnvelope
};
