'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const {
  classifyNoCandidateReason,
  isNoCandidateSandboxFailure,
  isNoCandidateStopReason,
  noCandidateStatusPatch
} = require('../src/self-improvement/worker.cjs');
const { loadSelfImprovementConfig } = require('../src/self-improvement/config.cjs');

const config = loadSelfImprovementConfig();
for (const key of [
  'agent_run_wall_clock_budget_ms',
  'model_turn_deadline_ms',
  'implementation_write_deadline_ms',
  'implementation_no_progress_deadline_ms',
  'focused_repair_no_progress_deadline_ms'
]) {
  assert.equal(
    Number.isFinite(Number(config[key])) && Number(config[key]) > 0,
    true,
    key + ' must be YAML-authoritative and finite'
  );
}

const agent = source('containers/self-improvement/agent.cjs');
for (const snippet of [
  'createProgressDeadlines',
  'progress_heartbeat',
  'agent_run_wall_clock_budget_exceeded',
  'implementation_write_deadline_exceeded',
  'focused_repair_progress_stalled',
  'transient_model_failure_budget_exhausted',
  'AbortController',
  'model_turn_deadline_exceeded'
]) {
  assert.match(agent, new RegExp(snippet));
}
assert.doesNotMatch(agent, /MAX_ITERATIONS\s*=\s*10000/);

const worker = source('src/self-improvement/worker.cjs');
assert.match(worker, /NO_CANDIDATE_STOP_REASONS/);
assert.match(worker, /stopCurrentContainer\(preemptReason, config\)/);
assert.match(worker, /noCandidateStatusPatch\(message, executionStatus, completedAt\)/);

for (const reason of [
  'agent_run_wall_clock_budget_exceeded',
  'implementation_write_deadline_exceeded',
  'implementation_progress_stalled',
  'focused_repair_progress_stalled',
  'model_turn_deadline_exceeded',
  'transient_model_failure_budget_exhausted'
]) {
  assert.equal(isNoCandidateStopReason(reason), true, reason);
  assert.equal(isNoCandidateSandboxFailure(reason), true, reason);
  assert.equal(classifyNoCandidateReason(reason), reason, reason);
}

const auditNoCandidate = JSON.stringify({
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT',
  type: 'no_candidate',
  detail: {
    reason: 'implementation_write_deadline_exceeded',
    elapsed_ms: 1001,
    convergence: {
      phase: 'implementing',
      iteration: 4,
      write_count: 0,
      last_write_iteration: null,
      selected_experiment: {
        objective: 'repair bounded progress deadline'
      }
    }
  }
});
const auditHeartbeat = JSON.stringify({
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_AGENT_AUDIT',
  type: 'progress_heartbeat',
  detail: {
    run_id: 'rsi-test-run',
    generation: 1,
    phase: 'implementing',
    iteration: 4,
    write_count: 0,
    last_write_time: null,
    last_write_iteration: null,
    elapsed_ms: 999
  }
});
const patch = noCandidateStatusPatch(
  [
    auditHeartbeat,
    'model narration that must stay in the terminal log only',
    auditNoCandidate
  ].join('\n'),
  { log_file: '/tmp/floki-rsi-terminal.log', run_id: 'rsi-test-run' },
  '2026-07-02T00:00:00.000Z'
);

assert.equal(patch.last_no_candidate_error.run_id, 'rsi-test-run');
assert.equal(
  patch.last_no_candidate_error.reason,
  'implementation_write_deadline_exceeded'
);
assert.equal(patch.last_no_candidate_error.phase, 'implementing');
assert.equal(patch.last_no_candidate_error.iteration, 4);
assert.equal(patch.last_no_candidate_error.write_count, 0);
assert.equal(
  patch.last_no_candidate_error.selected_objective,
  'repair bounded progress deadline'
);
assert.equal(
  patch.last_no_candidate_error.terminal_log_file,
  '/tmp/floki-rsi-terminal.log'
);
assert.equal(
  String(JSON.stringify(patch.last_no_candidate_error)).includes(
    'model narration that must stay in the terminal log only'
  ),
  false,
  'status.json must not store raw terminal narration'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_PROGRESS_DEADLINE_CONTRACT_PASS',
  bounded_deadline_reasons_verified: true
}, null, 2));
