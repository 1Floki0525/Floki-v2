'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createNightlyTrainingCoordinator,
  readRemClaims
} = require('../src/self-improvement/training/training-scheduler.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-nightly-rem-'));
  const dreamTxt = path.join(root, 'dream.txt');
  const dreamJson = path.join(root, 'dream.json');
  fs.writeFileSync(dreamTxt, 'dream');
  fs.writeFileSync(dreamJson, '{}');

  const config = {
    training_enabled: true,
    nightly_training_enabled: true,
    nightly_rem_provider: 'huggingface',
    training_rem_claim_file: path.join(root, 'claims.json')
  };
  const calls = [];
  let owner = 'hf_training';
  let hfCalls = 0;
  let session = {
    run_id: 'nightly-test',
    sleep_date: '2026-06-27',
    active: true,
    finalized: false,
    resource_entered: true,
    training_failed: false,
    completed_epochs: 1,
    rem_cycles_completed: 0,
    latest_checkpoint: '/tmp/checkpoint-epoch-1',
    current_container: null
  };

  const gpu = {
    currentOwner() { return owner; },
    readOwner() { return { owner }; },
    transfer(from, to) {
      calls.push('gpu:' + from + '->' + to);
      assert.equal(owner, from);
      owner = to;
      return { owner };
    },
    acquire(to) {
      calls.push('gpu:none->' + to);
      owner = to;
      return { owner };
    },
    release(from) {
      calls.push('gpu:release:' + from);
      assert.equal(owner, from);
      owner = null;
    }
  };

  const coordinator = createNightlyTrainingCoordinator({
    config,
    gpu,
    enter_resource: async () => ({ ok: true }),
    exit_resource: async () => ({ ok: true, result: { lifecycle_restored: true } }),
    read_session: () => session,
    refresh_session: (value) => value,
    set_resource_entered: (value, entered) => {
      session = { ...value, resource_entered: entered };
      return session;
    },
    start_segment: async (value) => {
      calls.push('resume-training');
      session = { ...value, current_container: 'training-container-2' };
      return session;
    },
    write_session: (value) => {
      session = value;
      return value;
    },
    get_sleep_window: () => ({
      sleep_date: '2026-06-27',
      start_at: '2026-06-28T03:00:00.000Z',
      end_at: '2026-06-28T11:00:00.000Z'
    }),
    is_within_sleep_window: () => true,
    read_manual_nap: () => null,
    run_hf_generation: async () => {
      calls.push('hf-rem-generation');
      hfCalls += 1;
      return {
        model: 'approved-lineage-test',
        response_json: {
          title: 'A Test Dream',
          dream_story: 'I crossed a long bridge under a bright sky and remembered why I keep learning.',
          emotional_tone: 'hopeful',
          symbols: ['bridge'],
          consolidation_summary: 'Learning continues through change.',
          first_person_reflection: 'I feel more certain about continuing carefully.'
        }
      };
    },
    run_dream_engine: async (options) => {
      const generation = await options.dream_generator({
        prompt: 'prompt',
        context: {},
        schema: {}
      });
      assert.equal(generation.model, 'approved-lineage-test');
      return {
        ok: true,
        marker: 'FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS',
        dream_txt_file: dreamTxt,
        dream_metadata_file: dreamJson
      };
    },
    audit: () => {},
    status: () => {}
  });

  const first = await coordinator.runNightlyRem({
    now: new Date('2026-06-28T04:10:00.000Z')
  });
  assert.equal(first.ok, true);
  assert.equal(first.provider, 'huggingface');
  assert.equal(first.approved_lineage_only, true);
  assert.deepEqual(calls, [
    'gpu:hf_training->hf_rem_inference',
    'hf-rem-generation',
    'gpu:hf_rem_inference->hf_training',
    'resume-training'
  ]);

  const second = await coordinator.runNightlyRem({
    now: new Date('2026-06-28T04:10:01.000Z')
  });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true,
    'second REM call with no new completed epoch must skip');
  assert.equal(second.completed_epochs, 1);
  assert.equal(second.completed_rem_cycles, 1);
  assert.equal(hfCalls, 1,
    'completed REM claim must not regenerate a dream');
  assert.equal(readRemClaims(config).claims['2026-06-27:cycle-1'].status, 'complete');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_NIGHTLY_REM_HANDOFF_PASS',
    epoch_triggered_rem: true,
    gpu_handoff_order_verified: true,
    approved_hf_lineage_only: true,
    exact_once_completed_claim: true
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
