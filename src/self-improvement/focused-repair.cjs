'use strict';

// Bounded focused-repair tool policy + failure-context reinjection for the RSI
// agent. Imported by containers/self-improvement/agent.cjs so the live agent and
// its contract tests exercise the SAME policy — not a test-only reproduction.
//
// Problem it solves: when a generated focused test failed, the agent kept the
// full tool surface (including a generic write shell, full verification, and
// finalize), so it could wander or simulate the decision path outside the
// failing test and stall with implementation_progress_stalled_before_verification.
// During repair the agent must fix the REAL production source or the REAL
// focused-test file and rerun the focused test — nothing else.

// Tools permitted while the agent is repairing a failing focused test.
const REPAIR_ALLOWED_TOOLS = Object.freeze([
  'get_task_state',
  'update_task_state',
  'get_self_context',
  'search_self_memory',
  'list_repository',
  'search_source',
  'inspect_symbol',
  'read_file',
  'apply_patch',
  'write_file',
  'show_diff',
  'git_status',
  'run_focused_test',
  'report_no_safe_candidate'
]);

// Tools explicitly withheld during repair. Generic shell is withheld so the
// decision path cannot be simulated outside the failing test; run_verification
// and finalize_candidate are withheld until the focused test passes.
const REPAIR_WITHHELD_TOOLS = Object.freeze([
  'shell',
  'run_verification',
  'finalize_candidate'
]);

function isRepairPhase(phase) {
  return String(phase || '') === 'repairing';
}

// Select the advertised tool surface for the current convergence phase. This is
// the single source of truth the agent uses each turn, so the contract test can
// drive real convergence snapshots through the same function the agent runs:
//   - no experiment selected, deadline reached  -> [selectExperimentTool]
//   - no experiment selected, still discovering  -> preSelectionTools (read-only)
//   - experiment selected, repairing             -> repairTools (bounded)
//   - experiment selected, otherwise             -> allTools (full surface)
function selectActiveTools(snapshot, surfaces) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const s = surfaces && typeof surfaces === 'object' ? surfaces : {};
  if (snap.selected_experiment) {
    return isRepairPhase(snap.phase) ? s.repairTools : s.allTools;
  }
  if (snap.phase === 'selection_required') {
    // Selection pressure offers both structured decisions: one bounded
    // experiment or an evidence-backed no-safe-candidate declaration.
    return [
      s.selectExperimentTool,
      s.reportNoSafeCandidateTool
    ].filter(Boolean);
  }
  return s.preSelectionTools;
}

// Select the bounded repair tool surface from the full tool list.
function selectRepairTools(allTools, nameOf) {
  const getName = typeof nameOf === 'function'
    ? nameOf
    : (tool) => (tool && tool.function && tool.function.name) || null;
  const allowed = new Set(REPAIR_ALLOWED_TOOLS);
  return (Array.isArray(allTools) ? allTools : []).filter((tool) =>
    allowed.has(getName(tool))
  );
}


function buildDeniedRevisionContext(revisionConstraint) {
  const row = revisionConstraint && typeof revisionConstraint === 'object'
    ? revisionConstraint
    : {};
  const plan = row.plan && typeof row.plan === 'object' ? row.plan : {};
  return [
    'DENIED-CANDIDATE REVISION CONSTRAINT — this requirement remains active.',
    '  candidate: ' + String(row.revising_denied || '(unknown)'),
    '  denial reason: ' + String(row.denial_reason || '(missing)'),
    '  denial requirement: ' + String(plan.denial_requirement || '(missing)'),
    '  implementation change: ' + String(plan.implementation_change || '(missing)'),
    '  focused-test change: ' + String(plan.focused_test_change || '(missing)'),
    'Do not repeat the denied implementation or the denied proof strategy.'
  ].join('\n');
}

// Build a guaranteed per-turn failure-context block from the latest focused-test
// result so the model always sees the exact failing command, exit status, and
// output while repairing — regardless of conversation compaction.
function buildFocusedRepairContext(latestFocusedResult, targetFiles = [], revisionConstraint = null) {
  const row = latestFocusedResult && typeof latestFocusedResult === 'object'
    ? latestFocusedResult
    : {};
  const files = (Array.isArray(targetFiles) ? targetFiles : []).filter(Boolean);

  const lines = [
    'FOCUSED TEST FAILED — bounded repair mode is active.',
    '',
    'Latest focused-test result:',
    '  command: ' + String(row.command || '(unknown)'),
    '  exit status: ' + String(row.status == null ? '(unknown)' : row.status),
    '  timed_out: ' + String(row.timed_out === true)
  ];
  if (Array.isArray(row.changed_files_after_test) && row.changed_files_after_test.length > 0) {
    lines.push('  changed files: ' + row.changed_files_after_test.join(', '));
  }
  lines.push('');
  lines.push('stdout (tail):');
  lines.push(String(row.stdout_tail || '').trim() || '(empty)');
  lines.push('');
  lines.push('stderr (tail):');
  lines.push(String(row.stderr_tail || '').trim() || '(empty)');
  lines.push('');
  if (files.length > 0) {
    lines.push('Target files: ' + files.join(', '));
    lines.push('');
  }
  if (revisionConstraint && typeof revisionConstraint === 'object') {
    lines.push(buildDeniedRevisionContext(revisionConstraint));
    lines.push('');
  }
  lines.push('Repair instructions:');
  lines.push('1. Re-read the FAILING TEST itself with read_file before editing anything.');
  lines.push('2. Re-read the relevant PRODUCTION SOURCE the test exercises.');
  lines.push('3. Decide whether the contradiction is in the production source or in the test. The production code is NOT assumed wrong — a generated test can be the broken side.');
  lines.push('4. Do NOT add fake helpers that hardcode the expected outcome (for example returning shouldRetry=true), and do NOT assert mock behavior that never executes the real production function.');
  lines.push('5. Make the SMALLEST correct repair to the real source or the real test file using apply_patch or write_file.');
  lines.push('6. Re-run the focused test with run_focused_test. Full verification and finalize stay unavailable until the focused test passes.');

  return lines.join('\n');
}

module.exports = {
  REPAIR_ALLOWED_TOOLS,
  REPAIR_WITHHELD_TOOLS,
  isRepairPhase,
  selectActiveTools,
  selectRepairTools,
  buildFocusedRepairContext,
  buildDeniedRevisionContext
};
