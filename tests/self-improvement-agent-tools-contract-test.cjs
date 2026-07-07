'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const agent = fs.readFileSync(
  path.join(ROOT, 'containers/self-improvement/agent.cjs'),
  'utf8'
);
const policy = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/convergence-policy.cjs'),
  'utf8'
);
const worker = fs.readFileSync(
  path.join(ROOT, 'src/self-improvement/worker.cjs'),
  'utf8'
);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Behavioral helpers: the per-phase tool-surface routing and the workspace
// containment guard are exercised through the REAL production helpers the agent
// uses, rather than asserting agent.cjs source-text adjacency or syntax.
const {
  selectActiveTools,
  selectRepairTools
} = require(path.join(ROOT, 'src/self-improvement/focused-repair.cjs'));
const {
  assertRealPathInsideRoot
} = require(path.join(ROOT, 'src/self-improvement/workspace-guard.cjs'));

for (const toolName of [
  'get_task_state',
  'update_task_state',
  'get_self_context',
  'search_self_memory',
  'list_repository',
  'search_source',
  'inspect_symbol',
  'read_file',
  'write_file',
  'apply_patch',
  'show_diff',
  'git_status',
  'shell',
  'run_focused_test',
  'run_verification',
  'web_search',
  'web_fetch',
  'browser_fetch',
  'github_search',
  'arxiv_search',
  'crossref_search',
  'context7_resolve_library',
  'context7_query_docs',
  'record_benchmark',
  'finalize_candidate'
]) {
  assert.match(agent, new RegExp("name: '" + toolName + "'"), toolName);
}

assert.match(agent, /const taskState = \{/);
assert.match(agent, /task-state\.json/);
assert.match(agent, /workspace_changed:\s*false/);
assert.match(agent, /write_file_noop/);
assert.match(agent, /write_file rejected likely partial overwrite/);
assert.match(agent, /runGitSync\(\['apply', '--check'/);
assert.match(agent, /runGitSync\(\['diff', '--check'\]/);
assert.match(agent, /focused test must pass before full verification/);
assert.match(agent, /run_focused_test refuses shell pipelines/);
assert.match(agent, /validateFocusedTestCommand/);
assert.match(agent, /normalizeFocusedTestDescriptor/);
assert.match(agent, /canonicalFocusedTestCommand/);
assert.match(agent, /focusedTestPathFromCommand/);
assert.match(agent, /bash bin\/floki-node24-run\.sh node/);
assert.ok(agent.includes("'(?:\\\\s|$)'"));
assert.match(agent, /validateExperimentFocusedTest/);
assert.match(agent, /shellFocusedTestRejection/);
assert.match(agent, /FLOKI_V2_SELF_IMPROVEMENT_SHELL_FOCUSED_TEST_REJECTED/);
assert.match(agent, /focused_test_shell_rejected/);
assert.match(agent, /Never run the focused test through shell/);
assert.match(agent, /candidate diff changed after verification/);
assert.match(agent, /verifiedPatchSha/);
assert.match(agent, /function currentPatchText\(\)/);
assert.match(agent, /const patch = currentPatchText\(\)/);
assert.match(agent, /controllerAutoFinalize/);
assert.match(agent, /candidate_auto_finalized_after_verification/);
assert.match(agent, /printSandboxPass/);
assert.match(agent, /finalCommandAuditFile/);
assert.match(agent, /fs\.existsSync\(path\.dirname\(commandAuditFile\)\)/);
assert.match(agent, /fs\.mkdirSync\(path\.dirname\(auditFile\)/);
assert.match(agent, /private self-context/);
assert.match(agent, /Never leak private self-context/);
assert.match(agent, /createReadStream\(indexFile/);
assert.doesNotMatch(agent, /first model tool call should be select_experiment/,
  'agent must not force blind selection before investigation');
assert.match(agent, /Investigate.*before calling select_experiment|Investigate.*codebase.*self-context.*select_experiment/,
  'agent must encourage investigation before calling select_experiment');
assert.match(agent, /const selectExperimentTool = \{/);
assert.match(agent, /const tools = \[\s*selectExperimentTool,/);
// Behavioral: the per-phase tool surface is chosen by the real selectActiveTools
// helper the agent invokes. Drive it with representative snapshots and assert the
// routing instead of pinning agent.cjs ternary syntax or source-line adjacency.
{
  const selectExperimentTool = { function: { name: 'select_experiment' } };
  const allTools = [
    selectExperimentTool,
    { function: { name: 'shell' } },
    { function: { name: 'read_file' } },
    { function: { name: 'apply_patch' } },
    { function: { name: 'write_file' } },
    { function: { name: 'run_focused_test' } },
    { function: { name: 'run_verification' } },
    { function: { name: 'finalize_candidate' } }
  ];
  const blocked = new Set(['apply_patch', 'write_file', 'run_focused_test', 'run_verification', 'finalize_candidate']);
  const preSelectionTools = allTools.filter((t) => !blocked.has(t.function.name));
  const repairTools = selectRepairTools(allTools, (t) => t.function.name);
  const surfaces = { allTools, preSelectionTools, selectExperimentTool, repairTools };

  // A selected experiment exposes the full implementation tool surface.
  assert.equal(
    selectActiveTools({ selected_experiment: { objective: 'x' }, phase: 'implementing' }, surfaces),
    allTools,
    'a selected experiment exposes the full implementation tool surface'
  );
  // selection_required exposes only select_experiment.
  assert.deepEqual(
    selectActiveTools({ selected_experiment: null, phase: 'selection_required' }, surfaces)
      .map((t) => t.function.name),
    ['select_experiment'],
    'selection_required exposes only select_experiment'
  );
  // Normal pre-selection discovery exposes the read-only discovery surface.
  assert.equal(
    selectActiveTools({ selected_experiment: null, phase: 'discovery' }, surfaces),
    preSelectionTools,
    'pre-selection discovery exposes preSelectionTools before the deadline'
  );
  // Repairing exposes the bounded repair surface (no shell/verification/finalize).
  const repairActive = selectActiveTools({ selected_experiment: { objective: 'x' }, phase: 'repairing' }, surfaces)
    .map((t) => t.function.name);
  for (const withheld of ['shell', 'run_verification', 'finalize_candidate']) {
    assert.ok(!repairActive.includes(withheld), 'repair surface excludes ' + withheld);
  }
}
assert.match(agent, /PRE_SELECTION_BLOCKED_NAMES/,
  'agent must define the set of tools blocked before selection');
assert.match(agent, /preSelectionTools/,
  'agent must define and use preSelectionTools discovery surface');
assert.match(agent, /function preSelectionInvalidToolFeedback/);
assert.match(agent, /pre_selection_invalid_tool_rejected/);
assert.match(agent, /function selectExperimentCorrectionFeedback/);
assert.match(agent, /select_experiment_rejected/);
assert.match(agent, /placeholder measurements/);
assert.doesNotMatch(agent, /The pre-selection turn exposes only select_experiment/,
  'agent must not claim only select_experiment is callable before selection');
assert.match(agent, /full isolated-sandbox read, write, shell/);
assert.match(agent, /function isAllowedExperimentTarget/);
assert.match(agent, /clean\.startsWith\('src\/'\)/);
assert.match(agent, /clean\.startsWith\('tests\/'\)/);
assert.match(agent, /experiment target must be an existing source, test, config, container, interface, or package file/);
assert.match(agent, /experiment target file does not exist/);
assert.match(agent, /function validateExperimentEvidence/);
assert.match(agent, /percentage or latency claims require measured baseline evidence/);
assert.match(agent, /must not describe runtime error codes as HTTP status codes/);
assert.match(agent, /baseline_evidence must not contain placeholder measurements/);
assert.match(agent, /KNOWN_RUNTIME_ERROR_CODE_PATTERN/);
assert.match(agent, /\\bE\[A-Z0-9_\]\{2,\}\\b/);
assert.match(agent, /PLACEHOLDER_METRIC_TOKEN_PATTERN/);
assert.doesNotMatch(agent, /A-Z\]\[A-Z0-9\]\*_\[A-Z0-9_\]\{2,\}/);
assert.match(agent, /retry\/backoff claims require measured baseline evidence/);
assert.doesNotMatch(agent, /clean\.startsWith\('\\.floki-self-improvement\/'\)/);
// Behavioral: real-path containment (extracted to workspace-guard.cjs and used
// by the agent) rejects an escape through a symlink resolving outside the root.
assert.match(agent, /assertRealPathInsideRoot|assertRealPathInsideWorkspace/,
  'agent must wire the real-path workspace containment guard');
{
  const wsRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'floki-agtools-ws-'));
  const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'floki-agtools-out-'));
  try {
    const wsReal = fs.realpathSync.native(wsRoot);
    fs.writeFileSync(path.join(outside, 'secret.cjs'), 'leak');
    fs.symlinkSync(path.join(outside, 'secret.cjs'), path.join(wsRoot, 'escape.cjs'));
    assert.throws(
      () => assertRealPathInsideRoot(wsReal, path.join(wsRoot, 'escape.cjs'), 'target'),
      /escapes workspace/,
      'symlink escape is rejected by the containment guard'
    );
  } finally {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

assert.match(policy, /result\?\.workspace_changed === true/);
assert.match(policy, /name === 'run_focused_test'/);
assert.match(policy, /name === 'apply_patch'/);
assert.match(policy, /focused_repair_must_fix_then_rerun/);
assert.match(policy, /focusedVerificationFailures/);
const {
  createConvergencePolicy
} = require(path.join(
  ROOT,
  'src/self-improvement/convergence-policy.cjs'
));

const convergenceConfigKeys = Array.from(
  policy.matchAll(
    /requiredPositiveInteger\(\s*config,\s*'([^']+)'\s*\)/g
  ),
  (match) => match[1]
);
assert.ok(
  convergenceConfigKeys.length > 0,
  'the convergence policy must declare its positive-integer configuration'
);

const behavioralPolicy = createConvergencePolicy(
  Object.fromEntries(
    convergenceConfigKeys.map((name) => [name, 4])
  )
);
behavioralPolicy.beginIteration(1);
behavioralPolicy.selectExperiment({
  objective: 'Verify focused-test workflow guidance behavior.',
  hypothesis: 'A structured write must lead to run_focused_test guidance.',
  success_metric: 'guidance directs the agent to run_focused_test',
  baseline_evidence: 'The contract executes the real convergence policy.',
  focused_test: 'node tests/example-focused-test.cjs',
  expected_follow_on_value: 'Preserve structured verification ordering.',
  target_files: ['src/self-improvement/convergence-policy.cjs']
});
behavioralPolicy.startImplementation();
behavioralPolicy.record(
  'apply_patch',
  {},
  { ok: true, workspace_changed: true }
);

const focusedTestGuidance = behavioralPolicy.guidance();
assert.match(
  focusedTestGuidance,
  /focused test/i,
  'after a structured implementation write, guidance must require the selected focused test'
);
assert.match(
  focusedTestGuidance,
  /full verification/i,
  'focused-test guidance must preserve the required transition to full verification'
);
assert.doesNotMatch(
  focusedTestGuidance,
  /(?:run|execute).{0,120}focused test.{0,120}(?:via|through|using)\s+shell/i,
  'guidance must never direct the agent to execute its focused test through shell'
);

assert.match(worker, /FLOKI_V2_SELF_IMPROVEMENT_NO_SAFE_CANDIDATE/i);
assert.equal(
  pkg.scripts['self-improvement:once'],
  'bash bin/floki-node24-run.sh node src/self-improvement/worker.cjs --once --force'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_AGENT_TOOLS_CONTRACT_PASS'
}, null, 2));
