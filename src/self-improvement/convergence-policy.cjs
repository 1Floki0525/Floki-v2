'use strict';

const crypto = require('node:crypto');

function requiredPositiveInteger(config, name) {
  const value = config[name];
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('convergence policy requires a positive integer: ' + name);
  }
  return value;
}

function requiredString(config, name) {
  const value = config[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('convergence policy requires a non-empty string: ' + name);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function signatureFor(name, args) {
  return crypto
    .createHash('sha256')
    .update(String(name))
    .update('\0')
    .update(JSON.stringify(stableValue(args || {})))
    .digest('hex');
}

function cleanRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!raw || raw.startsWith('/')) return '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.includes('..')) return '';
  return parts.join('/');
}

function splitShellSegments(command) {
  return String(command || '')
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripNonMutatingRedirections(command) {
  return String(command || '')
    .replace(/(^|\s)(?:[012])?>\s*\/dev\/null(?=\s|$)/g, '$1')
    .replace(/(^|\s)[012]>&[012](?=\s|$)/g, '$1')
    .replace(/(^|\s)<\s*\/dev\/null(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReadOnlyShell(command) {
  const inspected = stripNonMutatingRedirections(command);
  const segments = splitShellSegments(inspected);
  if (segments.length === 0) return false;

  const forbidden = /(^|\s)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|tee|patch|npm|npx|pnpm|yarn|pip|pip3|python|python3|perl|ruby|make|cmake|meson|ninja|cargo|go|javac|git\s+(?:add|commit|apply|am|checkout|switch|reset|restore|clean|stash|merge|rebase|cherry-pick|tag|branch|init))(\s|$)/i;
  const writeSyntax = /(?:^|[^<])>{1,2}|\bsed\s+-i\b|\bperl\s+-[^\s]*i\b/i;
  if (forbidden.test(inspected) || writeSyntax.test(inspected)) return false;

  const allowed = /^(?:cd\b|ls\b|find\b|rg\b|grep\b|cat\b|head\b|tail\b|wc\b|stat\b|file\b|jq\b|pwd\b|which\b|command\s+-v\b|sed\s+-n\b|git\s+(?:status|diff|show|log|ls-files|rev-parse)\b|node\s+--check\b)/i;
  return segments.every((segment) => allowed.test(segment));
}

function isVerificationShell(command) {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;

  const unsafe = /(?:^|[^<])>{1,2}|\bsed\s+-i\b|\bperl\s+-[^\s]*i\b|(^|\s)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|tee|patch|git\s+(?:add|commit|apply|am|checkout|switch|reset|restore|clean|stash|merge|rebase|cherry-pick|tag|branch|init))(\s|$)/i;
  if (unsafe.test(command)) return false;

  const allowed = /^(?:cd\b|node\s+(?:--test\b|(?:tests?|test)\/|[^\s]+(?:test|spec)\.(?:c?js|mjs|ts)\b)|npm\s+(?:test\b|run\s+(?:test(?::[\w.-]+)?|build|lint|typecheck|check)\b)|bash\s+bin\/[^\s]*(?:test|proof|verify)[^\s]*\b|python3?\s+-m\s+(?:pytest|unittest)\b|pytest\b|shellcheck\b|cargo\s+test\b|go\s+test\b|make\s+test\b)/i;
  return segments.every((segment) => allowed.test(segment));
}

function createConvergencePolicy(config, emit = () => {}) {
  const limits = Object.freeze({
    discoveryToolLimit: requiredPositiveInteger(config, 'discovery_tool_limit'),
    researchToolLimit: requiredPositiveInteger(config, 'research_tool_limit'),
    repeatedSignatureLimit: requiredPositiveInteger(
      config,
      'repeated_tool_signature_limit'
    ),
    objectiveDeadline: requiredPositiveInteger(
      config,
      'objective_selection_deadline_iteration'
    ),
    implementationDeadline: requiredPositiveInteger(
      config,
      'implementation_start_deadline_iteration'
    ),
    searchOnlyStreakLimit: requiredPositiveInteger(
      config,
      'search_only_streak_limit'
    ),
    failedLookupLimit: requiredPositiveInteger(config, 'failed_lookup_limit'),
    maxNoChangeIterations: requiredPositiveInteger(
      config,
      'max_no_change_iterations'
    ),
    focusedVerificationFailureLimit: requiredPositiveInteger(
      config,
      'focused_verification_failure_limit'
    )
  });

  if (limits.objectiveDeadline >= limits.implementationDeadline) {
    throw new Error(
      'objective_selection_deadline_iteration must be less than ' +
      'implementation_start_deadline_iteration'
    );
  }

  const researchTools = new Set([
    'web_search',
    'web_fetch',
    'browser_fetch',
    'github_search',
    'arxiv_search',
    'crossref_search',
    'context7_resolve_library',
    'context7_query_docs',
    'corpus_search',
    'corpus_fetch'
  ]);

  const readTools = new Set([
    'get_task_state',
    'get_self_context',
    'search_self_memory',
    'list_repository',
    'search_source',
    'inspect_symbol',
    'read_file'
  ]);

  const signatures = new Map();
  const state = {
    iteration: 0,
    phase: 'discovery',
    selectedExperiment: null,
    selectedExperimentAtIteration: null,
    implementationStarted: false,
    implementationStartedAtIteration: null,
    lastWriteIteration: null,
    writeCount: 0,
    discoveryCalls: 0,
    researchCalls: 0,
    searchOnlyStreak: 0,
    failedLookups: 0,
    verificationRuns: 0,
    focusedVerificationFailures: 0,
    lastFocusedFailureIteration: null,
    noWriteGuidanceIssuedAtIteration: null,
    postWriteGuidanceIssuedAtIteration: null,
    blockedCalls: 0,
    noToolTurns: 0
  };

  function classifyTool(name, args = {}) {
    const shellReadOnly =
      name === 'shell' && isReadOnlyShell(args.command);
    const shellVerification =
      name === 'shell' && isVerificationShell(args.command);
    const shellMutation =
      name === 'shell' && !shellReadOnly && !shellVerification;

    return Object.freeze({
      read:
        readTools.has(name) ||
        shellReadOnly,
      discovery:
        !state.implementationStarted &&
        (name === 'read_file' || shellReadOnly),
      research: researchTools.has(name),
      verification:
        name === 'run_verification' ||
        name === 'run_focused_test' ||
        shellVerification,
      mutation:
        name === 'write_file' ||
        name === 'apply_patch' ||
        shellMutation
    });
  }

  function snapshot() {
    return Object.freeze({
      iteration: state.iteration,
      phase: state.phase,
      selected_experiment: state.selectedExperiment,
      selected_experiment_at_iteration:
        state.selectedExperimentAtIteration,
      implementation_started: state.implementationStarted,
      implementation_started_at_iteration:
        state.implementationStartedAtIteration,
      last_write_iteration: state.lastWriteIteration,
      write_count: state.writeCount,
      discovery_calls: state.discoveryCalls,
      research_calls: state.researchCalls,
      search_only_streak: state.searchOnlyStreak,
      failed_lookups: state.failedLookups,
      verification_runs: state.verificationRuns,
      focused_verification_failures: state.focusedVerificationFailures,
      last_focused_failure_iteration: state.lastFocusedFailureIteration,
      no_write_guidance_issued_at_iteration:
        state.noWriteGuidanceIssuedAtIteration,
      post_write_guidance_issued_at_iteration:
        state.postWriteGuidanceIssuedAtIteration,
      blocked_calls: state.blockedCalls,
      no_tool_turns: state.noToolTurns
    });
  }

  function selectedTargetFiles() {
    if (
      !state.selectedExperiment ||
      !Array.isArray(state.selectedExperiment.target_files)
    ) {
      return [];
    }
    return state.selectedExperiment.target_files
      .map(cleanRelativePath)
      .filter(Boolean);
  }

  function isSelectedTargetPath(value) {
    const relative = cleanRelativePath(value);
    if (!relative) return false;
    return selectedTargetFiles().some((target) => {
      return relative === target || relative.startsWith(target + '/');
    });
  }

  function isNarrowSelectedTargetInspection(name, args = {}) {
    if (!state.selectedExperiment) return false;
    if (name === 'read_file') return isSelectedTargetPath(args.path);
    if (
      (name === 'search_source' || name === 'inspect_symbol') &&
      args.path
    ) {
      return isSelectedTargetPath(args.path);
    }
    return false;
  }

  function transition(phase, reason) {
    if (state.phase === phase) return;
    const previous = state.phase;
    state.phase = phase;
    emit('convergence_phase', {
      previous,
      phase,
      reason,
      iteration: state.iteration
    });
  }

  function beginIteration(iteration) {
    state.iteration = Number(iteration);
    if (
      !state.selectedExperiment &&
      state.iteration >= limits.objectiveDeadline
    ) {
      transition('selection_required', 'objective_selection_deadline');
    } else if (
      state.selectedExperiment &&
      !state.implementationStarted &&
      state.selectedExperimentAtIteration !== null &&
      state.iteration - state.selectedExperimentAtIteration >=
        limits.maxNoChangeIterations
    ) {
      transition(
        'implementation_required',
        'implementation_start_grace_exhausted'
      );
    }
    return snapshot();
  }

  function block(reason, name, detail = {}) {
    state.blockedCalls += 1;
    emit('convergence_block', {
      reason,
      tool: name,
      iteration: state.iteration,
      ...detail
    });
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_CONVERGENCE_BLOCK',
      reason,
      phase: state.phase,
      required_next_action: guidance()
    });
  }

  function advise(reason, name, detail = {}) {
    emit('convergence_advisory', {
      reason,
      tool: name,
      iteration: state.iteration,
      required_next_action: guidance(),
      ...detail
    });
  }

  function authorize(name, args = {}) {
    if (
      name === 'select_experiment' ||
      name === 'start_implementation' ||
      name === 'write_memory'
    ) {
      return Object.freeze({ ok: true });
    }

    if (
      !state.selectedExperiment &&
      state.phase === 'selection_required'
    ) {
      return block('selection_required', name, {
        allowed_next_tools: ['select_experiment']
      });
    }

    const kinds = classifyTool(name, args);
    const narrowTargetInspection =
      isNarrowSelectedTargetInspection(name, args);
    const signature = signatureFor(name, args);
    const seen = signatures.get(signature) || 0;
    if (!kinds.verification && seen >= limits.repeatedSignatureLimit) {
      advise('repeated_tool_signature_limit', name, {
        signature,
        previous_calls: seen
      });
    }

    const isDiscovery = kinds.discovery;
    const isResearch = kinds.research;

    if (!state.selectedExperiment && (kinds.mutation || kinds.verification)) {
      return block('pre_selection_mutation_blocked', name, {
        allowed_next_tools: [
          'select_experiment',
          'get_task_state',
          'get_self_context',
          'search_self_memory',
          'list_repository',
          'search_source',
          'inspect_symbol',
          'read_file',
          'corpus_search',
          'corpus_fetch'
        ]
      });
    }

    if (
      (state.phase === 'selection_required' ||
       state.phase === 'implementation_required') &&
      (isDiscovery || isResearch)
    ) {
      advise('phase_requires_progression', name);
    }

    if (isDiscovery && state.discoveryCalls >= limits.discoveryToolLimit) {
      transition('selection_required', 'discovery_tool_limit');
      advise('discovery_tool_limit', name);
    }

    if (isResearch && state.researchCalls >= limits.researchToolLimit) {
      transition('selection_required', 'research_tool_limit');
      advise('research_tool_limit', name);
    }

    if (
      state.searchOnlyStreak >= limits.searchOnlyStreakLimit &&
      (isDiscovery || isResearch)
    ) {
      transition('selection_required', 'search_only_streak_limit');
      advise('search_only_streak_limit', name);
    }

    if (
      state.failedLookups >= limits.failedLookupLimit &&
      (isDiscovery || isResearch)
    ) {
      transition('selection_required', 'failed_lookup_limit');
      advise('failed_lookup_limit', name);
    }

    if (
      name === 'shell' &&
      !state.implementationStarted &&
      kinds.mutation
    ) {
      advise('mutating_shell_requires_start_implementation', name);
    }

    if (name === 'write_file' && !state.implementationStarted) {
      advise('write_requires_start_implementation', name);
    }

    if (
      (kinds.verification || name === 'finalize_candidate') &&
      (!state.implementationStarted || state.writeCount === 0)
    ) {
      advise('verification_requires_implemented_change', name);
    }

    const postWriteVerificationGrace = Math.max(
      1,
      Math.floor(limits.maxNoChangeIterations / 2)
    );
    if (
      state.implementationStarted &&
      state.writeCount === 0 &&
      state.implementationStartedAtIteration !== null &&
      (kinds.read || isResearch) &&
      !narrowTargetInspection &&
      state.iteration - state.implementationStartedAtIteration >=
        postWriteVerificationGrace
    ) {
      return block('implementation_write_required', name, {
        allowed_next_tools: [
          'write_file',
          'apply_patch',
          'read_file(target_files)',
          'search_source(target_files)',
          'inspect_symbol(target_files)',
          'show_diff',
          'git_status'
        ],
        implementation_write_grace: postWriteVerificationGrace
      });
    }
    if (
      state.implementationStarted &&
      state.writeCount > 0 &&
      state.lastWriteIteration !== null &&
      state.phase !== 'verified' &&
      state.phase !== 'repairing' &&
      kinds.read &&
      !narrowTargetInspection &&
      state.iteration - state.lastWriteIteration >= postWriteVerificationGrace
    ) {
      return block('post_write_verification_required', name, {
        allowed_next_tools: [
          'run_focused_test',
          'write_file',
          'apply_patch',
          'read_file(target_files)',
          'search_source(target_files)',
          'inspect_symbol(target_files)',
          'show_diff',
          'git_status',
          'run_verification'
        ],
        post_write_verification_grace: postWriteVerificationGrace
      });
    }

    signatures.set(signature, seen + 1);
    if (isDiscovery) state.discoveryCalls += 1;
    if (isResearch) state.researchCalls += 1;
    return Object.freeze({ ok: true, signature });
  }

  function selectExperiment(args = {}) {
    if (state.selectedExperiment) {
      return block('experiment_already_selected', 'select_experiment');
    }

    const objective = requiredString(args, 'objective');
    const hypothesis = requiredString(args, 'hypothesis');
    const successMetric = requiredString(args, 'success_metric');
    const baselineEvidence = requiredString(args, 'baseline_evidence');
    const focusedTest = requiredString(args, 'focused_test');
    const expectedFollowOnValue = requiredString(
      args,
      'expected_follow_on_value'
    );
    const targetFiles = Array.isArray(args.target_files)
      ? args.target_files.map((item) => String(item).trim()).filter(Boolean)
      : [];

    if (targetFiles.length === 0) {
      throw new Error('select_experiment requires at least one target file');
    }

    state.selectedExperiment = Object.freeze({
      objective,
      hypothesis,
      success_metric: successMetric,
      baseline_evidence: baselineEvidence,
      focused_test: focusedTest,
      focused_test_description: typeof args.focused_test_description === 'string' ? args.focused_test_description.trim() : null,
      expected_follow_on_value: expectedFollowOnValue,
      target_files: Object.freeze(targetFiles)
    });
    state.selectedExperimentAtIteration = state.iteration;
    state.searchOnlyStreak = 0;
    transition('experiment_selected', 'select_experiment');
    emit('experiment_selected', {
      iteration: state.iteration,
      experiment: state.selectedExperiment
    });
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_EXPERIMENT_SELECTED',
      experiment: state.selectedExperiment
    });
  }

  function startImplementation() {
    if (!state.selectedExperiment) {
      return block(
        'select_experiment_required',
        'start_implementation'
      );
    }
    if (state.implementationStarted) {
      return Object.freeze({
        ok: true,
        marker: 'FLOKI_V2_SELF_IMPROVEMENT_IMPLEMENTATION_ALREADY_STARTED'
      });
    }
    state.implementationStarted = true;
    state.implementationStartedAtIteration = state.iteration;
    state.searchOnlyStreak = 0;
    transition('implementing', 'start_implementation');
    emit('implementation_started', {
      iteration: state.iteration,
      experiment: state.selectedExperiment
    });
    return Object.freeze({
      ok: true,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_IMPLEMENTATION_STARTED'
    });
  }

  function record(name, args = {}, result = null) {
    const kinds = classifyTool(name, args);
    const isDiscovery = kinds.discovery;
    const isResearch = kinds.research;
    const blocked =
      result?.marker === 'FLOKI_V2_SELF_IMPROVEMENT_CONVERGENCE_BLOCK';
    const failed =
      result &&
      (
        result.ok === false ||
        (name === 'shell' && Number(result.status) !== 0)
      );

    if (!blocked) {
      state.noToolTurns = 0;
    }

    if (!blocked && failed && (isDiscovery || isResearch)) {
      state.failedLookups += 1;
    }

    if (!blocked && (isDiscovery || isResearch)) {
      state.searchOnlyStreak += 1;
    } else if (
      name === 'select_experiment' ||
      name === 'start_implementation' ||
      kinds.verification
    ) {
      state.searchOnlyStreak = 0;
    }

    const mutatingShell =
      name === 'shell' &&
      kinds.mutation &&
      result?.workspace_changed === true;

    const realToolMutation =
      (name === 'write_file' || name === 'apply_patch') &&
      result?.workspace_changed === true;

    if (!failed && mutatingShell) {
      advise('shell_mutation_not_structured_progress', name, {
        required_edit_tools: ['apply_patch', 'write_file']
      });
    }

    if (!failed && realToolMutation) {
      if (!state.implementationStarted) {
        state.implementationStarted = true;
        state.implementationStartedAtIteration = state.iteration;
        emit('implementation_started', {
          iteration: state.iteration,
          experiment: state.selectedExperiment,
          reason: 'workspace_mutation'
        });
      }
      state.writeCount += 1;
      state.lastWriteIteration = state.iteration;
      state.noWriteGuidanceIssuedAtIteration = null;
      state.postWriteGuidanceIssuedAtIteration = null;
      state.searchOnlyStreak = 0;
      transition('implementing', 'workspace_mutation');
    }

    if (kinds.verification) {
      state.verificationRuns += 1;
      state.searchOnlyStreak = 0;
      if (name === 'run_verification') {
        transition(
          result && result.ok === true ? 'verified' : 'repairing',
          result && result.ok === true
            ? 'verification_passed'
            : 'verification_failed'
        );
      } else if (name === 'run_focused_test') {
        if (failed) {
          state.focusedVerificationFailures += 1;
          state.lastFocusedFailureIteration = state.iteration;
          transition('repairing', 'focused_verification_failed');
        } else {
          state.focusedVerificationFailures = 0;
          state.lastFocusedFailureIteration = null;
          transition('focused_verified', 'focused_verification_passed');
        }
      } else if (failed) {
        transition('repairing', 'verification_shell_failed');
      }
    }

    emit('convergence_state', snapshot());
    return snapshot();
  }

  function recordNoToolTurn() {
    state.noToolTurns += 1;
    emit('convergence_no_tool_turn', {
      iteration: state.iteration,
      phase: state.phase,
      consecutive_no_tool_turns: state.noToolTurns,
      limit: limits.maxNoChangeIterations
    });

    if (state.noToolTurns < limits.maxNoChangeIterations) {
      return null;
    }

    const reason = state.selectedExperiment
      ? 'model_repeatedly_returned_no_tool_calls'
      : 'model_repeatedly_returned_no_tool_calls_before_selection';
    advise(reason, 'model_turn', {
      consecutive_no_tool_turns: state.noToolTurns,
      limit: limits.maxNoChangeIterations
    });
    return reason;
  }

  function endIteration() {
    if (!state.selectedExperiment &&
        state.iteration >= limits.implementationDeadline) {
      advise(
        'model_failed_to_select_experiment_after_forced_selection',
        'end_iteration'
      );
      return 'model_failed_to_select_experiment_after_forced_selection';
    }
    if (state.selectedExperiment &&
        !state.implementationStarted &&
        state.selectedExperimentAtIteration !== null &&
        state.iteration - state.selectedExperimentAtIteration >=
          limits.maxNoChangeIterations) {
      advise(
        'implementation_not_started_after_selection_grace',
        'end_iteration'
      );
      return 'implementation_not_started_after_selection_grace';
    }
    if (state.implementationStarted &&
        state.writeCount === 0 &&
        state.iteration - state.implementationStartedAtIteration >=
          limits.maxNoChangeIterations) {
      if (
        state.noWriteGuidanceIssuedAtIteration === null ||
        state.noWriteGuidanceIssuedAtIteration === state.iteration
      ) {
        state.noWriteGuidanceIssuedAtIteration = state.iteration;
        advise('implementation_write_required_before_stop', 'end_iteration');
        return null;
      }
      advise('implementation_has_no_workspace_change', 'end_iteration');
      return 'implementation_has_no_workspace_change';
    }
    if (state.implementationStarted &&
        state.focusedVerificationFailures >=
          limits.focusedVerificationFailureLimit) {
      advise('focused_verification_failed_repeatedly', 'end_iteration', {
        focused_verification_failures: state.focusedVerificationFailures,
        focused_verification_failure_limit:
          limits.focusedVerificationFailureLimit
      });
      return 'focused_verification_failed_repeatedly';
    }
    if (state.implementationStarted &&
        state.lastWriteIteration !== null &&
        state.phase !== 'verified' &&
        state.phase !== 'focused_verified' &&
        state.iteration - state.lastWriteIteration >=
          limits.maxNoChangeIterations) {
      if (
        state.postWriteGuidanceIssuedAtIteration === null ||
        state.postWriteGuidanceIssuedAtIteration === state.iteration
      ) {
        state.postWriteGuidanceIssuedAtIteration = state.iteration;
        advise('implementation_verification_required_before_stop', 'end_iteration');
        return null;
      }
      advise('implementation_progress_stalled_before_verification', 'end_iteration');
      return 'implementation_progress_stalled_before_verification';
    }
    return null;
  }

  function guidance() {
    if (!state.selectedExperiment) {
      return (
        'Call select_experiment now with one bounded objective, a falsifiable ' +
        'hypothesis, baseline evidence, target files, a measurable success ' +
        'metric, one focused test, and expected follow-on value.'
      );
    }
    if (!state.implementationStarted) {
      return (
        'Call start_implementation now, then implement the selected target ' +
        'surface and add the focused test. Sandbox tools remain available.'
      );
    }
    if (state.writeCount === 0) {
      return (
        'Make the next tool call apply_patch or write_file and create the ' +
        'selected source/test change now. Narrow read_file, search_source, ' +
        'and inspect_symbol calls against selected target files remain allowed; ' +
        'shell remains available, but shell-created filesystem changes do not ' +
        'count as structured implementation progress.'
      );
    }
    if (state.phase !== 'verified') {
      const ft = state.selectedExperiment?.focused_test
        ? ' Your focused test is: ' +
          state.selectedExperiment.focused_test +
          '. Call run_focused_test with no arguments — it runs that command automatically.'
        : ' Call run_focused_test with no arguments.';
      if (state.focusedVerificationFailures > 0) {
        return (
          'Call run_focused_test now to re-run the focused test and verify your repair. ' +
          'Do NOT call select_experiment — the experiment is already selected. ' +
          'Fix the implementation based on the focused-test failure output; do not ' +
          'rewrite the experiment or invent new metrics. ' +
          'After run_focused_test passes, call run_verification.' + ft
        );
      }
      return (
        'Run the focused test now using the run_focused_test tool — never via ' +
        'shell, pipelines, or head/tail wrappers; shell test ' +
        'runs cannot unlock full verification. ' +
        'After run_focused_test passes, call run_verification.' + ft
      );
    }
    return 'Call finalize_candidate with the verified experiment evidence.';
  }

  function feedback() {
    const prefix =
      'Sandbox tools remain fully available; this is workflow guidance, not a tool denial. ';
    if (!state.selectedExperiment && state.iteration <= limits.objectiveDeadline) {
      return (
        prefix +
        'selected_experiment is null. Make the next tool call select_experiment ' +
        'as a planning anchor using the requested objective and an existing ' +
        'repository file, then continue investigating, editing, searching, and ' +
        'verifying freely inside the sandbox.'
      );
    }
    if (!state.selectedExperiment && state.implementationStarted) {
      return (
        prefix +
        'selected_experiment is still null after workspace changes. Call ' +
        'select_experiment now using the actual target files and falsifiable ' +
        'objective, then continue implementation and verification.'
      );
    }
    if (!state.selectedExperiment &&
        state.iteration >= limits.objectiveDeadline) {
      return prefix + guidance();
    }
    if (state.selectedExperiment &&
        !state.implementationStarted) {
      return prefix + guidance();
    }
    if (state.implementationStarted && state.writeCount === 0) {
      return prefix + guidance();
    }
    if (state.implementationStarted &&
        state.writeCount > 0 &&
        state.phase !== 'verified' &&
        state.lastWriteIteration !== null &&
        state.iteration - state.lastWriteIteration >=
          limits.maxNoChangeIterations) {
      return prefix + guidance();
    }
    return null;
  }

  return Object.freeze({
    authorize,
    beginIteration,
    endIteration,
    feedback,
    guidance,
    isReadOnlyShell,
    record,
    recordNoToolTurn,
    selectExperiment,
    snapshot,
    startImplementation
  });
}

module.exports = {
  createConvergencePolicy,
  isReadOnlyShell,
  isVerificationShell,
  signatureFor,
  stripNonMutatingRedirections
};
