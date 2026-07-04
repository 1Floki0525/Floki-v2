'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  createConvergencePolicy
} = require(path.join(
  ROOT,
  'src/self-improvement/convergence-policy.cjs'
));

const config = {
  discovery_tool_limit: 18,
  research_tool_limit: 10,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 8,
  implementation_start_deadline_iteration: 12,
  search_only_streak_limit: 6,
  failed_lookup_limit: 5,
  max_no_change_iterations: 6,
  focused_verification_failure_limit: 6,
  focused_repair_no_progress_iteration_limit: 12
};

const events = [];
const policy = createConvergencePolicy(config, (type, detail) => {
  events.push({ type, detail });
});

policy.beginIteration(1);
policy.record('get_task_state', {}, { ok: true });
policy.record('get_self_context', {}, { ok: true });
policy.record('search_source', { query: 'select_experiment' }, { ok: true });
policy.record(
  'read_file',
  { path: 'src/self-improvement/convergence-policy.cjs' },
  {
    path: 'src/self-improvement/convergence-policy.cjs',
    content: 'function createConvergencePolicy() {}'
  }
);

assert.equal(policy.snapshot().autonomous_selection_ready, true);
assert.deepEqual(policy.snapshot().autonomous_selection_evidence, {
  task_state: true,
  self_context: true,
  repository_evidence: true,
  source_file: true
});
assert.ok(
  events.some((event) => event.type === 'autonomous_selection_ready')
);

const deadlinePolicy = createConvergencePolicy(config);
for (
  let iteration = 1;
  iteration <= config.objective_selection_deadline_iteration;
  iteration += 1
) {
  deadlinePolicy.beginIteration(iteration);
}
assert.equal(deadlinePolicy.snapshot().phase, 'discovery');
assert.equal(deadlinePolicy.snapshot().autonomous_selection_ready, false);

const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
const sandbox = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/sandbox.cjs'),
  'utf8'
);
const configSource = fs.readFileSync(
  path.join(ROOT, 'src/config/floki-config.cjs'),
  'utf8'
);
const template = fs.readFileSync(
  path.join(ROOT, 'config/chat.config.yaml.temp'),
  'utf8'
);

for (const source of [agent, sandbox, configSource, template]) {
  assert.doesNotMatch(
    source,
    /selection_rescue|runAutonomousSelectionRescue|json_content|tool-only/i
  );
}
assert.match(agent, /runAutonomousSelectionTransaction/);
assert.match(agent, /format:\s*selectExperimentSchema/);
assert.match(agent, /protocol:\s*'ollama_json_schema'/);
assert.match(agent, /executeTool\('select_experiment', args\)/);
assert.match(agent, /requestPayload\.format = options\.format/);
assert.match(
  agent,
  /if \(Array\.isArray\(tools\) && tools\.length > 0\)/
);
assert.doesNotMatch(
  agent,
  /extractJsonObject|selectExperimentArgsFromMessage/
);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_V2_RSI_AUTONOMOUS_SELECTION_READINESS_CONTRACT_PASS',
  autonomous_selection_ready: true,
  selection_protocol: 'ollama_json_schema',
  rescue_path_removed: true
}, null, 2));
