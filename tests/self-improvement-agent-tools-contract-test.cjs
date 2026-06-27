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
const convergenceSnapshotIndex = agent.indexOf(
  'const convergenceSnapshot = convergencePolicy.snapshot();'
);
const activeToolsIndex = agent.indexOf(
  'const activeTools = convergenceSnapshot.selected_experiment',
  convergenceSnapshotIndex
);
const activeToolsEndIndex = agent.indexOf('let message;', activeToolsIndex);

assert.ok(
  convergenceSnapshotIndex >= 0,
  'agent must snapshot convergence state before choosing the active tool surface'
);
assert.ok(
  activeToolsIndex > convergenceSnapshotIndex,
  'agent must derive activeTools from the captured convergence snapshot'
);
assert.ok(
  activeToolsEndIndex > activeToolsIndex,
  'agent activeTools block must terminate before the model call setup'
);

const activeToolsBlock = agent.slice(activeToolsIndex, activeToolsEndIndex);
assert.match(
  activeToolsBlock,
  /selected_experiment\s*\?\s*tools/,
  'a selected experiment must expose the full implementation tool surface'
);
assert.match(
  activeToolsBlock,
  /phase\s*===\s*'selection_required'[\s\S]*\?\s*\[selectExperimentTool\]/,
  'selection_required must expose only select_experiment and stop further discovery churn'
);
assert.match(
  activeToolsBlock,
  /:\s*preSelectionTools\s*;/,
  'normal pre-selection discovery must expose preSelectionTools before the deadline'
);
assert.ok(
  activeToolsBlock.indexOf('? tools') <
    activeToolsBlock.indexOf("phase === 'selection_required'"),
  'full tools must be selected first when an experiment already exists'
);
assert.ok(
  activeToolsBlock.indexOf("phase === 'selection_required'") <
    activeToolsBlock.lastIndexOf('preSelectionTools'),
  'discovery tools must remain the fallback only before selection becomes mandatory'
);
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
assert.match(agent, /must not describe EAI_AGAIN as HTTP status code 123/);
assert.match(agent, /baseline_evidence must not contain placeholder measurements/);
assert.match(agent, /KNOWN_RUNTIME_ERROR_CODE_PATTERN/);
assert.match(agent, /EAI_AGAIN\|EPIPE\|ECONNRESET\|ETIMEDOUT/);
assert.match(agent, /PLACEHOLDER_METRIC_TOKEN_PATTERN/);
assert.doesNotMatch(agent, /A-Z\]\[A-Z0-9\]\*_\[A-Z0-9_\]\{2,\}/);
assert.match(agent, /retry\/backoff claims require measured baseline evidence/);
assert.doesNotMatch(agent, /clean\.startsWith\('\\.floki-self-improvement\/'\)/);
assert.match(agent, /escapes workspace through symlink/);

assert.match(policy, /result\?\.workspace_changed === true/);
assert.match(policy, /name === 'run_focused_test'/);
assert.match(policy, /name === 'apply_patch'/);
assert.match(policy, /focused_verification_failed_repeatedly/);
assert.match(policy, /focusedVerificationFailures/);
assert.match(policy, /shell test\s*' \+/);

assert.match(worker, /FLOKI_V2_SELF_IMPROVEMENT_SANDBOX_NO_CANDIDATE/i);
assert.equal(
  pkg.scripts['self-improvement:once'],
  'bash bin/floki-node24-run.sh node src/self-improvement/worker.cjs --once --force'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_RSI_AGENT_TOOLS_CONTRACT_PASS'
}, null, 2));
