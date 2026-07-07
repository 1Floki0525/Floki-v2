'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { getSelfImprovementConfig } =
  require('../src/config/floki-config.cjs');
const {
  createConvergencePolicy,
  isReadOnlyShell,
  isVerificationShell
} = require('../src/self-improvement/convergence-policy.cjs');
const {
  loadResearchCorpus,
  searchResearchCorpus,
  getResearchCorpusSource
} = require('../src/self-improvement/research-corpus.cjs');

const config = getSelfImprovementConfig('chat');

for (const key of [
  'discovery_tool_limit',
  'research_tool_limit',
  'repeated_tool_signature_limit',
  'objective_selection_deadline_iteration',
  'implementation_start_deadline_iteration',
  'search_only_streak_limit',
  'failed_lookup_limit',
  'max_no_change_iterations',
  'focused_verification_failure_limit',
  'focused_repair_no_progress_iteration_limit',
  'research_corpus_catalog_relative_path',
  'research_corpus_search_default_limit',
  'research_corpus_search_max_limit',
  'research_corpus_fetch_max_chars'
]) {
  assert.notEqual(config[key], undefined, 'missing YAML-backed key: ' + key);
}

assert.equal(isReadOnlyShell('rg -n "worker" src/self-improvement'), true);
assert.equal(isReadOnlyShell('git status --short --untracked-files=no'), true);
assert.equal(isReadOnlyShell('npm test'), false);
assert.equal(isReadOnlyShell('sed -i s/a/b/ file'), false);
assert.equal(isReadOnlyShell('cat file > other'), false);
assert.equal(
  isVerificationShell('node tests/example-contract-test.cjs'),
  true
);
assert.equal(
  isVerificationShell('cd apps/floki-neural-interface && npm run build'),
  true
);
assert.equal(isVerificationShell('node test.js > result.txt'), false);

const events = [];
const policy = createConvergencePolicy({
  discovery_tool_limit: 4,
  research_tool_limit: 3,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 3,
  implementation_start_deadline_iteration: 5,
  search_only_streak_limit: 3,
  failed_lookup_limit: 2,
  max_no_change_iterations: 2,
  focused_verification_failure_limit: 4,
  focused_repair_no_progress_iteration_limit: 6
}, (type, detail) => events.push({ type, detail }));

policy.beginIteration(1);
policy.selectExperiment({
  objective: 'Bound repeated discovery calls after selection',
  hypothesis: 'Repeated read-only source searches remain available before implementation starts',
  baseline_evidence: 'The policy starts with a selected experiment at iteration 1',
  target_files: ['src/self-improvement/convergence-policy.cjs'],
  success_metric: 'Repeated investigation emits advisory without blocking before implementation',
  focused_test: 'node tests/self-improvement-convergence-corpus-contract-test.cjs',
  expected_follow_on_value: 'Future experiments can inspect selected target files without broad restart'
});
assert.equal(policy.authorize('shell', { command: 'rg -n x src' }).ok, true);
policy.record('shell', { command: 'rg -n x src' }, { status: 0 });
assert.equal(policy.authorize('shell', { command: 'rg -n x src' }).ok, true);
policy.record('shell', { command: 'rg -n x src' }, { status: 0 });
assert.equal(
  policy.authorize('shell', { command: 'rg -n x src' }).ok,
  true,
  'repeated investigation must remain available inside the sandbox'
);
assert.equal(
  events.some((event) =>
    event.type === 'convergence_advisory' &&
    event.detail.reason === 'repeated_tool_signature_limit'
  ),
  true
);

policy.beginIteration(3);
assert.equal(
  policy.authorize('read_file', { path: 'package.json' }).ok,
  true,
  'selection pressure must not disable file reads'
);

assert.ok(policy.snapshot().selected_experiment);
assert.equal(
  policy.authorize('write_file', { path: 'x', content: 'y' }).ok,
  true,
  'sandbox writes must remain available before explicit implementation start'
);
assert.equal(policy.startImplementation().ok, true);
assert.equal(
  policy.authorize('write_file', { path: 'x', content: 'y' }).ok,
  true
);
policy.record('write_file', { path: 'x', content: 'y' }, {
  ok: true,
  workspace_changed: true
});
assert.equal(policy.snapshot().write_count, 1);

policy.beginIteration(4);
const postWriteRead = policy.authorize('shell', { command: 'git diff --stat' });
assert.equal(postWriteRead.ok, false);
assert.equal(postWriteRead.reason, 'post_write_verification_required');
assert.match(postWriteRead.required_next_action, /Run the focused test/);
assert.equal(
  policy.snapshot().discovery_calls,
  4,
  'post-write read blocking does not consume additional discovery budget'
);
assert.equal(
  policy.authorize('shell', {
    command: 'node tests/example-contract-test.cjs'
  }).ok,
  true,
  'focused verification must remain available after implementation starts'
);
policy.record(
  'shell',
  { command: 'node tests/example-contract-test.cjs' },
  { status: 0 }
);
assert.equal(policy.snapshot().write_count, 1);
assert.equal(policy.snapshot().verification_runs, 1);
for (let attempt = 0; attempt < 3; attempt += 1) {
  assert.equal(
    policy.authorize('shell', {
      command: 'node tests/example-contract-test.cjs'
    }).ok,
    true,
    'focused verification reruns must not be blocked as repeated discovery'
  );
  policy.record(
    'shell',
    { command: 'node tests/example-contract-test.cjs' },
    { status: 1 }
  );
  }

const mutationFirstEvents = [];
const mutationFirstPolicy = createConvergencePolicy({
  discovery_tool_limit: 4,
  research_tool_limit: 3,
  repeated_tool_signature_limit: 2,
  objective_selection_deadline_iteration: 3,
  implementation_start_deadline_iteration: 5,
  search_only_streak_limit: 3,
  failed_lookup_limit: 2,
  max_no_change_iterations: 2,
  focused_verification_failure_limit: 4,
  focused_repair_no_progress_iteration_limit: 6
}, (type, detail) => mutationFirstEvents.push({ type, detail }));
mutationFirstPolicy.beginIteration(2);
const preSelectionWrite = mutationFirstPolicy.authorize(
  'write_file',
  { path: 'x', content: 'y' }
);
assert.equal(preSelectionWrite.ok, false);
assert.equal(preSelectionWrite.reason, 'pre_selection_mutation_blocked',
  'write_file before selection must be blocked with pre_selection_mutation_blocked reason');
assert.match(
  mutationFirstPolicy.feedback(),
  /selected_experiment is null|select_experiment/,
  'pre-selection mutation block must feed back selection requirement'
);

const preSelectionRead = mutationFirstPolicy.authorize(
  'read_file',
  { path: 'src/self-improvement/convergence-policy.cjs' }
);
assert.equal(preSelectionRead.ok, true,
  'read_file must be allowed before select_experiment — discovery before selection is required');
const preSelectionSearch = mutationFirstPolicy.authorize(
  'search_source',
  { query: 'select_experiment' }
);
assert.equal(preSelectionSearch.ok, true,
  'search_source must be allowed before select_experiment — discovery before selection is required');
const preSelectionVerify = mutationFirstPolicy.authorize(
  'run_verification',
  {}
);
assert.equal(preSelectionVerify.ok, false,
  'run_verification must be blocked before select_experiment');
assert.equal(preSelectionVerify.reason, 'pre_selection_mutation_blocked',
  'run_verification block must use pre_selection_mutation_blocked reason');
const postMutationSelected = mutationFirstPolicy.selectExperiment({
  objective: 'Bound repeated discovery calls after mutation',
  hypothesis: 'A stateful policy can recover when a sandbox mutates first',
  baseline_evidence: 'A write was observed before selected_experiment was set',
  target_files: ['src/self-improvement/convergence-policy.cjs'],
  success_metric: 'Feedback requests selection without denying writes',
  focused_test: 'node tests/self-improvement-convergence-corpus-contract-test.cjs',
  expected_follow_on_value: 'Future experiments stop lingering with selected_experiment null'
});
assert.equal(postMutationSelected.ok, true);
assert.match(
  mutationFirstPolicy.feedback(),
  /Call start_implementation now|apply_patch or write_file/,
  'selection changes mutation-first guidance into implementation guidance'
);

const corpus = loadResearchCorpus(
  ROOT,
  config.research_corpus_catalog_relative_path
);
assert.ok(corpus.sources.length >= 20);
assert.ok(searchResearchCorpus(corpus, 'recursive self improvement', 10).length);
assert.equal(
  getResearchCorpusSource(corpus, 'swe-bench').kind,
  'coding-benchmark'
);
assert.equal(
  getResearchCorpusSource(corpus, 'mcp-official-servers').kind,
  'tool-ecosystem'
);

const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
for (const token of [
  'select_experiment',
  'start_implementation',
  'corpus_search',
  'corpus_fetch',
  'convergencePolicy.beginIteration',
  'convergencePolicy.endIteration',
  'compactConversation',
  'convergencePolicy.feedback',
  'validateExperimentTargetFiles',
  'think: thinkingEnabled',
  'MODEL_THINKING_ENABLED',
  'selectionAnchorMessage',
  'selection_anchor_reminder'
]) {
  assert.ok(agent.includes(token), 'agent missing convergence token: ' + token);
}
assert.doesNotMatch(
  agent,
  /first model tool call should be select_experiment/,
  'sandbox agent must not force immediate blind selection before investigation'
);
assert.match(
  agent,
  /PRE_SELECTION_BLOCKED_NAMES/,
  'sandbox agent must define bounded pre-selection tool surface that blocks mutation before selection'
);
assert.match(
  agent,
  /preSelectionTools/,
  'sandbox agent must expose a discovery tool surface before selection'
);
assert.match(
  agent,
  /Investigate.*before calling select_experiment|Investigate.*codebase.*self-context.*select_experiment|before.*select_experiment.*investigation/,
  'sandbox agent must encourage investigation before calling select_experiment'
);
assert.match(
  agent,
  /not Maker approval[\s\S]*full isolated-sandbox read, write, shell/,
  'experiment selection must not reduce sandbox tool access'
);
assert.match(
  agent,
  /full read, write, shell, package-install, build, test,[\s\S]*GitHub, arXiv/,
  'selection reminder must preserve full sandbox tool access'
);
assert.doesNotMatch(
  agent,
  /Repeated and equivalent searches are rejected/
);
assert.doesNotMatch(
  agent,
  /Broad discovery after implementation starts is prohibited/
);
assert.doesNotMatch(
  agent,
  /iteration_wall_clock_budget_ms\s*\|\|/,
  'iteration budget may not use a runtime fallback'
);

const sandbox = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/sandbox.cjs'),
  'utf8'
);
assert.match(sandbox, /discovery_tool_limit:\s*config\.discovery_tool_limit/);
assert.match(
  sandbox,
  /research_corpus_catalog_relative_path:\s*config\.research_corpus_catalog_relative_path/
);
assert.doesNotMatch(
  sandbox,
  /iteration_wall_clock_budget_ms/,
  'run-level wall-clock budgets were removed by the condition-driven execution contract'
);
assert.match(
  sandbox,
  /environment_check_command_timeout_ms:\s*\n?\s*config\.environment_check_command_timeout_ms/
);
assert.match(
  sandbox,
  /shell_command_progress_interval_ms:\s*\n?\s*config\.shell_command_progress_interval_ms/
);
for (const token of [
  'model_thinking_enabled: config.model_thinking_enabled',
  'agent_message_history_max_chars:',
  'agent_recent_message_count: config.agent_recent_message_count'
]) {
  assert.ok(sandbox.includes(token), 'sandbox missing RSI model token: ' + token);
}

const {
  agentConfig
} = require('../src/self-improvement/sandbox.cjs');
const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const resolvedConfig = loadSelfImprovementConfig();
const generatedAgentConfig = agentConfig(
  { run_id: 'run-now-contract' },
  {},
  resolvedConfig
);
for (const key of [
  'environment_check_command_timeout_ms',
  'shell_command_progress_interval_ms',
  'model_thinking_enabled',
  'agent_message_history_max_chars',
  'agent_recent_message_count',
  'agent_ollama_request_max_attempts',
  'agent_ollama_request_retry_backoff_ms',
  'occupied_candidate_statuses'
]) {
  assert.equal(
    generatedAgentConfig[key],
    resolvedConfig[key],
    'agent config did not receive YAML key: ' + key
  );
}
assert.equal(
  generatedAgentConfig.max_agent_iterations,
  resolvedConfig.max_agent_iterations,
  'agent config did not receive YAML key: max_agent_iterations'
);

assert.match(
  agent,
  /requireNumber\('environment_check_command_timeout_ms'\)/
);
assert.match(
  agent,
  /requireNumber\('shell_command_progress_interval_ms'\)/
);
assert.match(
  agent,
  /requireNumber\('agent_ollama_request_max_attempts'\)/,
  'agent must load Ollama retry attempts from YAML'
);
assert.match(
  agent,
  /requireNumber\('agent_ollama_request_retry_backoff_ms'\)/,
  'agent must load Ollama retry backoff from YAML'
);
assert.match(
  agent,
  /error\.code\s*=\s*'ETIMEDOUT'/,
  'Ollama timeout errors must be retry-classified'
);
assert.match(
  agent,
  /error\.code === 'EPIPE'[\s\S]*error\.code === 'ECONNRESET'[\s\S]*error\.code === 'ETIMEDOUT'/,
  'Ollama retries must include timeouts as well as transport resets'
);
assert.match(
  agent,
  /setTimeout\(\(\) => attempt\(retriesLeft - 1\), retryBackoffMs\)/,
  'Ollama retry backoff must use the YAML-provided value'
);
assert.doesNotMatch(
  agent,
  /return 5000;/
);

const worker = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/worker.cjs'),
  'utf8'
);
assert.doesNotMatch(
  worker,
  /shell_command_stalled_threshold_ms\s*\|\|/
);
assert.doesNotMatch(
  worker,
  /last_sandbox_log_file:\s*null/
);

const panel = fs.readFileSync(
  path.join(
    ROOT,
    'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
  ),
  'utf8'
);
assert.doesNotMatch(
  panel,
  /disabled=\{!status\?\.last_sandbox_log_file\}/
);

const interfaceApi = fs.readFileSync(
  path.join(ROOT, 'src/runtime/chat-local-interface-api.cjs'),
  'utf8'
);
assert.match(interfaceApi, /newestDirectChildFileWithin/);
assert.match(
  interfaceApi,
  /if \(recorded\) return recorded;[\s\S]*newestDirectChildFileWithin/
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_CONVERGENCE_CORPUS_CONTRACT_PASS',
  repeated_search_allowed_with_advisory: true,
  selection_deadline_advisory_only: true,
  implementation_gate_advisory_only: true,
  corpus_sources: corpus.sources.length,
  yaml_authority: true,
  run_now_agent_config_complete: true,
  sandbox_log_button_available: true,
  latest_sandbox_log_fallback: true
}, null, 2));
