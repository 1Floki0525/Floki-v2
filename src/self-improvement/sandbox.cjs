'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  loadFreshSelfImprovementConfig,
  loadSelfImprovementConfig
} = require('./config.cjs');
const { appendAudit, atomicJson, paths, updateStatus } = require('./store.cjs');
const { normalizeRunKind, candidateTypeForKind } = require('./run-kinds.cjs');
const {
  dependencyManifestRequiresNodeModules
} = require('./dependency-manifest.cjs');

function splitList(value, delimiter) {
  return String(value).split(delimiter).map((item) => item.trim()).filter(Boolean);
}

function engineRun(config, args, options = {}) {
  const result = spawnSync(config.sandbox_engine, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || config.podman_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.status !== 0) {
    throw new Error(
      config.sandbox_engine + ' ' + args.join(' ') +
      ' failed with status ' + result.status + '\n' +
      String(result.stdout || '') + '\n' +
      String(result.stderr || '')
    );
  }
  return result;
}

function runHostCommand(config, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || config.snapshot_rsync_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.status !== 0) {
    throw new Error(
      command + ' ' + args.join(' ') +
      ' failed with status ' + result.status + '\n' +
      String(result.stdout || '') + '\n' +
      String(result.stderr || '')
    );
  }
  return result;
}

function imageSourceFingerprint(config = loadSelfImprovementConfig()) {
  const hash = crypto.createHash(config.image_fingerprint_algorithm);
  for (const relative of splitList(config.image_source_files, '|')) {
    const absolute = path.resolve(config.project_root, relative);
    if (absolute !== config.project_root &&
        !absolute.startsWith(config.project_root + path.sep)) {
      throw new Error('sandbox image source path escapes project root: ' + relative);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error('sandbox image source is missing: ' + relative);
    }
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(absolute));
    hash.update('\0');
  }
  for (const value of [
    config.container_base_image,
    config.container_node_version,
    config.container_node_dist_base_url,
    config.container_browser_deb_url,
    config.container_browser_command_path,
    config.container_apt_packages,
    config.context7_package_name,
    config.context7_package_version,
    config.workspace_mount_path
  ]) {
    hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function inspectImageFingerprint(config) {
  const result = spawnSync(config.sandbox_engine, [
    'image',
    'inspect',
    '--format',
    '{{ index .Config.Labels "' + config.image_source_label + '" }}',
    config.image_name
  ], {
    encoding: 'utf8',
    timeout: config.podman_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value && value !== '<no value>' ? value : null;
}

function inspectImageId(config) {
  const result = spawnSync(config.sandbox_engine, [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    config.image_name
  ], {
    encoding: 'utf8',
    timeout: config.podman_command_timeout_ms,
    maxBuffer: config.podman_output_buffer_bytes
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value && value !== '<no value>' ? value : null;
}

function ensureImage(config = loadSelfImprovementConfig()) {
  const expected = imageSourceFingerprint(config);
  const actual = inspectImageFingerprint(config);
  if (actual === expected) return config.image_name;

  const containerDir = path.join(config.project_root, 'containers', 'self-improvement');
  engineRun(config, [
    'build',
    '--pull=missing',
    '--label', config.image_source_label + '=' + expected,
    '--build-arg', 'BASE_IMAGE=' + config.container_base_image,
    '--build-arg', 'NODE_VERSION=' + config.container_node_version,
    '--build-arg', 'NODE_DIST_BASE_URL=' + config.container_node_dist_base_url,
    '--build-arg', 'BROWSER_DEB_URL=' + config.container_browser_deb_url,
    '--build-arg', 'BROWSER_COMMAND_PATH=' + config.container_browser_command_path,
    '--build-arg', 'APT_PACKAGES=' + config.container_apt_packages,
    '--build-arg', 'CONTEXT7_PACKAGE=' + config.context7_package_name,
    '--build-arg', 'CONTEXT7_VERSION=' + config.context7_package_version,
    '--build-arg', 'WORKSPACE_PATH=' + config.workspace_mount_path,
    '-t', config.image_name,
    containerDir
  ], {
    cwd: config.project_root,
    timeout: config.image_build_timeout_ms
  });
  const rebuilt = inspectImageFingerprint(config);
  if (rebuilt !== expected) {
    throw new Error('sandbox image fingerprint verification failed after rebuild');
  }
  appendAudit('sandbox_image_built', {
    image: config.image_name,
    previous_fingerprint: actual,
    source_fingerprint: expected
  }, config);
  return config.image_name;
}

function currentContainerStopLock(config = loadSelfImprovementConfig()) {
  return paths(config).currentContainerFile + '.stop.lock';
}

function readCurrentContainer(config = loadSelfImprovementConfig()) {
  try {
    return JSON.parse(
      fs.readFileSync(paths(config).currentContainerFile, 'utf8')
    );
  } catch (_error) {
    return null;
  }
}

function readCurrentStopRequest(config = loadSelfImprovementConfig()) {
  const current = readCurrentContainer(config);
  if (!current || !current.stop_requested_at || !current.stop_reason) {
    return null;
  }
  return Object.freeze({
    run_id: current.run_id || null,
    container: current.name || null,
    unit: current.unit || null,
    reason: current.stop_reason,
    requested_at: current.stop_requested_at
  });
}

function sanitizeUnitToken(value) {
  const token = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!token) throw new Error('run unit token must not be empty');
  return token;
}

function agentRunUnitName(runId, config = loadSelfImprovementConfig()) {
  return (
    sanitizeUnitToken(config.run_unit_prefix_agent) +
    '-' + sanitizeUnitToken(runId) + '.service'
  );
}

function trainingRunUnitName(sessionId, config = loadSelfImprovementConfig()) {
  return (
    sanitizeUnitToken(config.run_unit_prefix_training) +
    '-' + sanitizeUnitToken(sessionId) + '.service'
  );
}

function remRunUnitName(sessionId, cycle, config = loadSelfImprovementConfig()) {
  return (
    sanitizeUnitToken(config.run_unit_prefix_rem) +
    '-' + sanitizeUnitToken(sessionId) +
    '-' + sanitizeUnitToken(String(cycle)) + '.service'
  );
}

function workstationExec(config, command, options = {}) {
  return spawnSync(
    config.sandbox_engine,
    ['exec', config.persistent_container_name, '/bin/sh', '-lc', command],
    {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: options.timeout || config.podman_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
}

// Stop only the active run's transient systemd unit inside the workstation.
// This is the ordinary-operations stop path (pause, abort, preemption, REM and
// training handoffs). It must never stop or remove the workstation container.
function stopActiveRunProcess(reason = 'preempted', config = loadSelfImprovementConfig()) {
  const claim = claimCurrentStopRequest(reason, config);
  if (!claim.request || !claim.request.container) return false;
  if (!claim.claimed) return true;

  const unit = claim.request.unit;
  let stopStatus = null;
  let stopError = null;
  if (unit) {
    const result = workstationExec(
      config,
      'systemctl stop ' + shellQuote(unit),
      { timeout: config.run_unit_stop_timeout_ms }
    );
    stopStatus = result.status;
    stopError = result.error ? result.error.message : null;
  } else {
    // Legacy record without a unit: stop any matching agent units so the run
    // cannot orphan, still without touching the workstation itself.
    const prefix = sanitizeUnitToken(config.run_unit_prefix_agent);
    const result = workstationExec(
      config,
      'systemctl list-units --plain --no-legend ' +
        shellQuote(prefix + '-*.service') +
        " | awk '{print $1}' | xargs -r -n1 systemctl stop",
      { timeout: config.run_unit_stop_timeout_ms }
    );
    stopStatus = result.status;
    stopError = result.error ? result.error.message : null;
  }
  appendAudit('run_process_stopped', {
    run_id: claim.request.run_id,
    container: claim.request.container,
    unit: unit || null,
    reason: claim.request.reason,
    requested_at: claim.request.requested_at,
    stop_status: stopStatus,
    stop_error: stopError,
    workstation_preserved: true
  }, config);
  return true;
}

// Stop the permanent workstation container itself. Reserved for runtime
// stop/reset; preserves the container definition, filesystem, caches, and
// persistence proof. Active run units are stopped first so no orphan
// process survives into the next start.
function stopWorkstationContainer(reason = 'runtime_stop', config = loadSelfImprovementConfig()) {
  const state = inspectPersistentContainer(config);
  if (!state.found) {
    return Object.freeze({ ok: true, stopped: false, found: false });
  }
  if (state.running) {
    const prefixes = [
      config.run_unit_prefix_agent,
      config.run_unit_prefix_training,
      config.run_unit_prefix_rem
    ].map(sanitizeUnitToken);
    workstationExec(
      config,
      prefixes
        .map((prefix) =>
          'systemctl list-units --plain --no-legend ' +
          shellQuote(prefix + '-*.service') +
          " | awk '{print $1}' | xargs -r -n1 systemctl stop")
        .join('; '),
      { timeout: config.run_unit_stop_timeout_ms }
    );
    const result = spawnSync(
      config.sandbox_engine,
      [
        'stop',
        '-t', String(config.container_stop_timeout_seconds),
        config.persistent_container_name
      ],
      {
        cwd: config.project_root,
        encoding: 'utf8',
        timeout: config.container_stop_command_timeout_ms,
        maxBuffer: config.podman_output_buffer_bytes
      }
    );
    appendAudit('workstation_stopped', {
      container: config.persistent_container_name,
      reason,
      stop_status: result.status,
      stop_error: result.error ? result.error.message : null,
      preserved: true
    }, config);
    if (result.status !== 0) {
      throw new Error(
        'workstation container stop failed: ' +
        String(result.stderr || result.stdout || '').trim()
      );
    }
  }
  const after = inspectPersistentContainer(config);
  return Object.freeze({
    ok: after.found && !after.running,
    stopped: true,
    found: after.found,
    running: after.running
  });
}

function parseInspectField(value) {
  const text = String(value || '').trim();
  if (!text || text === '<no value>') return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function claimCurrentStopRequest(
  reason = 'preempted',
  config = loadSelfImprovementConfig()
) {
  const p = paths(config);
  const lockFile = currentContainerStopLock(config);
  let descriptor = null;
  try {
    descriptor = fs.openSync(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return Object.freeze({
        claimed: false,
        request: readCurrentStopRequest(config)
      });
    }
    throw error;
  }

  try {
    const current = readCurrentContainer(config);
    if (!current || !current.name) {
      fs.rmSync(lockFile, { force: true });
      return Object.freeze({ claimed: false, request: null });
    }
    const request = Object.freeze({
      run_id: current.run_id || null,
      container: current.name,
      reason: String(reason || 'preempted'),
      requested_at: new Date().toISOString()
    });
    atomicJson(p.currentContainerFile, {
      ...current,
      stop_requested_at: request.requested_at,
      stop_reason: request.reason
    }, config);
    return Object.freeze({ claimed: true, request });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function inspectContainerStart(containerName, config = loadSelfImprovementConfig()) {
  const result = spawnSync(
    config.sandbox_engine,
    [
      'inspect',
      '--format',
      '{{json .State.Running}}|{{json .State.StartedAt}}',
      containerName
    ],
    {
      encoding: 'utf8',
      timeout: config.container_stop_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  if (result.status !== 0) {
    return Object.freeze({
      found: false,
      running: false,
      started_at: null,
      error: String(result.stderr || result.stdout || '').trim()
    });
  }

  const [runningRaw, startedRaw] = String(result.stdout || '')
    .trim()
    .split('|');
  const running = parseInspectField(runningRaw) === true;
  const startedAt = parseInspectField(startedRaw);
  return Object.freeze({
    found: true,
    running,
    started_at:
      typeof startedAt === 'string' && startedAt && !startedAt.startsWith('0001-01-01')
        ? startedAt
        : null,
    error: null
  });
}

async function waitForContainerStart(
  containerName,
  config = loadSelfImprovementConfig()
) {
  const deadline = Date.now() + config.run_now_ack_timeout_ms;
  let last = null;
  while (Date.now() <= deadline) {
    last = inspectContainerStart(containerName, config);
    if (last.found && last.started_at) return last;
    await new Promise((resolve) =>
      setTimeout(resolve, config.run_now_ack_poll_ms)
    );
  }
  throw new Error(
    'self-improvement sandbox container did not start within ' +
    String(config.run_now_ack_timeout_ms) +
    ' ms: ' +
    containerName +
    (last?.error ? ' (' + last.error + ')' : '')
  );
}

// Run Now may only be acknowledged after the run's transient unit actually
// has a live main process inside the workstation; unit activation without a
// process is not startup proof.
function failureTailSuffix(options = {}) {
  let tail = '';
  try {
    tail = typeof options.error_tail === 'function'
      ? options.error_tail()
      : options.error_tail;
  } catch (error) {
    tail = 'unable to read startup error tail: ' + String(error.message || error);
  }
  const normalized = String(tail || '').trim();
  return normalized
    ? '\nstartup error tail:\n' + normalized
    : '';
}

async function waitForRunUnitStart(
  unit,
  config = loadSelfImprovementConfig(),
  options = {}
) {
  const deadline = Date.now() + config.run_now_ack_timeout_ms;
  let lastState = null;
  let lastPid = 0;
  while (Date.now() <= deadline) {
    const result = workstationExec(
      config,
      'systemctl show ' + shellQuote(unit) +
        ' --property=ActiveState --property=MainPID 2>/dev/null'
    );
    const text = String(result.stdout || '');
    lastState = (text.match(/ActiveState=(\S+)/) || [])[1] || null;
    lastPid = Number((text.match(/MainPID=(\d+)/) || [])[1] || 0);
    if (lastState === 'active' && lastPid > 0) {
      return Object.freeze({ ok: true, state: lastState, main_pid: lastPid });
    }
    if (lastState === 'failed') {
      throw new Error(
        'run unit entered failed state before acknowledgement: ' + unit +
        failureTailSuffix(options)
      );
    }
    const agentExit = typeof options.agent_exit === 'function'
      ? options.agent_exit()
      : null;
    if (agentExit) {
      throw new Error(
        'sandbox agent process exited before acknowledgement (code=' +
        String(agentExit.code) + ', signal=' + String(agentExit.signal) +
        '): ' + unit + failureTailSuffix(options)
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, config.run_now_ack_poll_ms)
    );
  }
  throw new Error(
    'run unit did not start a live process within ' +
    String(config.run_now_ack_timeout_ms) + ' ms: ' + unit +
    ' (state=' + String(lastState) + ', pid=' + String(lastPid) + ')' +
    failureTailSuffix(options)
  );
}

function verificationCommands(config) {
  const sandboxCommands = [
    config.sandbox_verification_command_1,
    config.sandbox_verification_command_2,
    config.sandbox_verification_command_3
  ].filter(Boolean);
  if (sandboxCommands.length > 0) return sandboxCommands;
  return [
    config.verification_command_1,
    config.verification_command_2,
    config.verification_command_3
  ].filter(Boolean);
}

function agentConfig(snapshot, options, config) {
  const workspacePath =
    typeof options.workspace_path === 'string' && options.workspace_path.trim() !== ''
      ? options.workspace_path
      : config.workspace_mount_path;
  return {
    run_id: snapshot.run_id,
    workspace_path: workspacePath,
    outbox_path: config.outbox_mount_path,
    self_context_path: config.self_context_mount_path,
    self_context_manifest_file_name: config.self_context_manifest_file_name,
    self_context_index_file_name: config.self_context_index_file_name,
    self_context_search_default_limit: config.self_context_search_default_limit,
    self_context_search_max_limit: config.self_context_search_max_limit,
    self_context_result_max_chars: config.self_context_result_max_chars,
    self_context_index_chunk_chars: config.self_context_index_chunk_chars,
    model_socket_path: path.posix.join(
      config.model_proxy_mount_path,
      config.model_proxy_socket_name
    ),
    model_proxy_health_path: config.model_proxy_health_path,
    model_response_max_bytes: config.model_response_max_bytes,
    model_proxy_connection_header: config.model_proxy_connection_header,
    model_request_max_bytes: config.model_request_max_bytes,
    model_name: config.model.name,
    model_temperature: config.model.temperature,
    model_top_p: config.model.top_p,
    model_timeout_ms: config.model.timeout_ms,
    model_keep_alive: config.model.keep_alive,
    context_window: config.context_window,
    model_thinking_enabled: config.model_thinking_enabled,
    agent_message_history_max_chars:
      config.agent_message_history_max_chars,
    agent_recent_message_count: config.agent_recent_message_count,
    max_agent_iterations: config.max_agent_iterations,
    discovery_tool_limit: config.discovery_tool_limit,
    research_tool_limit: config.research_tool_limit,
    repeated_tool_signature_limit: config.repeated_tool_signature_limit,
    objective_selection_deadline_iteration: config.objective_selection_deadline_iteration,
    implementation_start_deadline_iteration: config.implementation_start_deadline_iteration,
    search_only_streak_limit: config.search_only_streak_limit,
    failed_lookup_limit: config.failed_lookup_limit,
    max_no_change_iterations: config.max_no_change_iterations,
    focused_verification_failure_limit:
      config.focused_verification_failure_limit,
    focused_repair_no_progress_iteration_limit:
      config.focused_repair_no_progress_iteration_limit,
    environment_check_command_timeout_ms:
      config.environment_check_command_timeout_ms,
    shell_command_progress_interval_ms:
      config.shell_command_progress_interval_ms,
    model_turn_deadline_ms:
      config.model_turn_deadline_ms,
    implementation_write_deadline_ms:
      config.implementation_write_deadline_ms,
    implementation_no_progress_deadline_ms:
      config.implementation_no_progress_deadline_ms,
    focused_repair_no_progress_deadline_ms:
      config.focused_repair_no_progress_deadline_ms,
    agent_ollama_request_max_attempts:
      config.agent_ollama_request_max_attempts,
    agent_ollama_request_retry_backoff_ms:
      config.agent_ollama_request_retry_backoff_ms,
    max_command_ms: config.max_command_ms,
    dependency_install_timeout_ms: config.dependency_install_timeout_ms,
    max_changed_files: config.max_changed_files,
    max_patch_bytes: config.max_patch_bytes,
    verification_commands: verificationCommands(config),
    objective: String(options.objective || config.default_objective),
    objective_source: options.objective ? 'maker_requested' : 'floki_selected',
    requested_objective: options.objective || null,
    run_kind: normalizeRunKind(options.kind, config),
    candidate_type: candidateTypeForKind(options.kind, config),
    general_web_enabled: config.general_web_enabled,
    context7_enabled: config.context7_enabled,
    research_corpus_catalog_relative_path: config.research_corpus_catalog_relative_path,
    research_corpus_search_default_limit: config.research_corpus_search_default_limit,
    research_corpus_search_max_limit: config.research_corpus_search_max_limit,
    research_corpus_fetch_max_chars: config.research_corpus_fetch_max_chars,
    context7_package_name: config.context7_package_name,
    context7_package_version: config.context7_package_version,
    context7_call_timeout_ms: config.context7_call_timeout_ms,
    context7_protocol_version: config.context7_protocol_version,
    context7_client_name: config.context7_client_name,
    context7_client_version: config.context7_client_version,
    agent_shell_output_buffer_bytes: config.agent_shell_output_buffer_bytes,
    agent_git_output_buffer_bytes: config.agent_git_output_buffer_bytes,
    agent_git_show_buffer_bytes: config.agent_git_show_buffer_bytes,
    agent_command_audit_max_chars: config.agent_command_audit_max_chars,
    agent_terminal_preview_max_chars: config.agent_terminal_preview_max_chars,
    agent_tool_result_max_chars: config.agent_tool_result_max_chars,
    agent_test_output_tail_chars: config.agent_test_output_tail_chars,
    agent_min_command_timeout_ms: config.agent_min_command_timeout_ms,
    agent_git_show_timeout_ms: config.agent_git_show_timeout_ms,
    command_timeout_overrides_ms: config.command_timeout_overrides_ms,
    agent_fetch_default_timeout_ms: config.agent_fetch_default_timeout_ms,
    agent_fetch_max_timeout_ms: config.agent_fetch_max_timeout_ms,
    agent_fetch_default_max_chars: config.agent_fetch_default_max_chars,
    agent_http_user_agent: config.agent_http_user_agent,
    agent_http_accept: config.agent_http_accept,
    agent_home_path: config.agent_home_path,
    agent_npm_cache_path: config.agent_npm_cache_path,
    agent_pip_cache_path: config.agent_pip_cache_path,
    persistent_dependency_cache_root: config.persistent_dependency_cache_root,
    persistent_dependency_cache_marker_file: config.persistent_dependency_cache_marker_file,
    dependency_fingerprint_algorithm: config.dependency_fingerprint_algorithm,
    browser_command: config.browser_command,
    browser_profile_root: config.browser_profile_root,
    browser_profile_prefix: config.browser_profile_prefix,
    browser_flags: splitList(config.browser_flags, '|'),
    browser_virtual_time_budget_ms: config.browser_virtual_time_budget_ms,
    browser_timeout_ms: config.browser_timeout_ms,
    browser_output_buffer_bytes: config.browser_output_buffer_bytes,
    browser_default_max_chars: config.browser_default_max_chars,
    browser_max_chars: config.browser_max_chars,
    web_search_url_template: config.web_search_url_template,
    web_search_redirect_base_url: config.web_search_redirect_base_url,
    web_search_default_limit: config.web_search_default_limit,
    web_search_max_limit: config.web_search_max_limit,
    web_search_max_chars: config.web_search_max_chars,
    github_search_url_template: config.github_search_url_template,
    github_search_default_limit: config.github_search_default_limit,
    github_search_max_limit: config.github_search_max_limit,
    github_search_max_chars: config.github_search_max_chars,
    github_accept: config.github_accept,
    arxiv_search_url_template: config.arxiv_search_url_template,
    arxiv_search_default_limit: config.arxiv_search_default_limit,
    arxiv_search_max_limit: config.arxiv_search_max_limit,
    arxiv_search_max_chars: config.arxiv_search_max_chars,
    arxiv_summary_max_chars: config.arxiv_summary_max_chars,
    arxiv_accept: config.arxiv_accept,
    crossref_search_url_template: config.crossref_search_url_template,
    crossref_search_default_limit: config.crossref_search_default_limit,
    crossref_search_max_limit: config.crossref_search_max_limit,
    crossref_search_max_chars: config.crossref_search_max_chars,
    crossref_accept: config.crossref_accept,
    ollama_chat_path: config.ollama_chat_path,
    ollama_stream: config.ollama_stream,
    dependency_install_locked_command: config.dependency_install_locked_command,
    dependency_install_unlocked_command: config.dependency_install_unlocked_command,
    interface_project_path: config.interface_project_path,
    snapshot_evidence_subdir: config.snapshot_evidence_subdir,
    snapshot_runtime_evidence_file_name: config.snapshot_runtime_evidence_file_name,
    occupied_candidate_statuses: config.occupied_candidate_statuses,
    no_safe_candidate_file_name: config.no_safe_candidate_file_name,
    run_failure_file_name: config.run_failure_file_name,
    terminal_stream_file_name: config.terminal_stream_file_name,
    terminal_stream_max_bytes: config.terminal_stream_max_bytes,
    terminal_sentinel_grace_ms: config.terminal_sentinel_grace_ms,
    terminal_interrupt_grace_ms: config.terminal_interrupt_grace_ms,
    pty_rows: config.pty_rows,
    pty_cols: config.pty_cols,
    default_objective: config.default_objective
  };
}

function smokeImage(config = loadSelfImprovementConfig()) {
  ensureImage(config);
  engineRun(config, [
    'run',
    '--rm',
    '--cap-drop=' + config.cap_drop,
    '--security-opt=' + config.security_opt,
    '--network', config.network_mode,
    '--entrypoint', 'bash',
    config.image_name,
    '-lc',
    config.container_smoke_command
  ], {
    cwd: config.project_root,
    timeout: config.podman_command_timeout_ms
  });
  return {
    ok: true,
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_IMAGE_SMOKE_PASS',
    image: config.image_name
  };
}

// Floki's RSI coding environment is a provision-once Ubuntu container.
// Its writable root filesystem survives every RSI cycle and every chat.local
// restart. Only run-specific sanitized workspaces are exposed; the live project,
// host container socket, secrets, and Maker-controlled promotion path are not.
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function mountOptionsInclude(options, value) {
  return String(options || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(String(value || '').trim());
}

function persistentSelfContextHostRoot(config = loadSelfImprovementConfig()) {
  const explicit = String(config.persistent_self_context_host_root || '').trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(config.runtime_root, 'persistent-self-context');
}

function persistentConfigHostRoot(config = loadSelfImprovementConfig()) {
  const explicit = String(config.persistent_config_host_root || '').trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(config.runtime_root, 'persistent-config');
}

function persistentConfigHostFile(config = loadSelfImprovementConfig()) {
  return path.join(
    persistentConfigHostRoot(config),
    path.posix.basename(config.container_config_path)
  );
}

function bindMountSpec(source, target, options) {
  const spec = [
    'type=bind',
    'src=' + source,
    'target=' + target
  ];
  if (mountOptionsInclude(options, 'ro')) {
    spec.push('ro');
  }
  return spec.join(',');
}

function containerPathForHost(hostPath, hostRoot, containerRoot) {
  const absolutePath = path.resolve(hostPath);
  const absoluteRoot = path.resolve(hostRoot);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'persistent sandbox path escapes mounted workspace root: ' + absolutePath
    );
  }

  if (!relative) return containerRoot;
  return path.posix.join(
    containerRoot,
    ...relative.split(path.sep).filter(Boolean)
  );
}

function persistentWorkspaceTarget(_snapshot = null, config = loadSelfImprovementConfig()) {
  const target = String(config.persistent_project_workspace_path || '').trim();
  if (!target || !target.startsWith('/')) {
    throw new Error('persistent_project_workspace_path must be an absolute container path');
  }
  if (target === '/' || target === config.persistent_workspace_root_mount_path) {
    throw new Error('persistent_project_workspace_path is not a safe project workspace');
  }
  return path.posix.normalize(target);
}

function persistentSourceMirrorHostRoot(config = loadSelfImprovementConfig()) {
  const name = String(config.persistent_source_mirror_directory_name || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('persistent_source_mirror_directory_name must be a safe directory name');
  }
  return path.join(config.workspace_root, name);
}

function rsyncExcludeArgs(config) {
  const args = [];
  for (const pattern of splitList(config.snapshot_exclude_patterns, '|')) {
    args.push('--exclude=' + pattern);
  }
  return args;
}

function clearDirectoryContents(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

function syncProductionSourceMirror(config = loadSelfImprovementConfig()) {
  const mirror = persistentSourceMirrorHostRoot(config);
  fs.mkdirSync(mirror, { recursive: true, mode: 0o700 });
  const args = [
    '-a',
    '--checksum',
    '--delete',
    '--prune-empty-dirs',
    '--itemize-changes',
    ...rsyncExcludeArgs(config),
    config.project_root + '/',
    mirror + '/'
  ];
  const result = runHostCommand(
    config,
    'rsync',
    args,
    { timeout: config.snapshot_rsync_timeout_ms }
  );
  return Object.freeze({
    host_path: mirror,
    container_path: containerPathForHost(
      mirror,
      config.workspace_root,
      config.persistent_workspace_root_mount_path
    ),
    changed_items: String(result.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean).length
  });
}

function sanitizedNpmrcCommand(config) {
  const lines = splitList(config.snapshot_sanitized_npmrc_lines, '|');
  if (lines.length === 0) return ':';
  return 'printf ' + shellQuote(lines.join('\n') + '\n') + ' > .npmrc';
}

function gitInfoExcludeCommand(config) {
  const patterns = splitList(config.snapshot_exclude_patterns, '|')
    .map((entry) => entry.replace(/\/$/, ''))
    .filter(Boolean);
  return 'mkdir -p .git/info && printf ' +
    shellQuote(patterns.join('\n') + '\n') +
    ' > .git/info/exclude';
}

function syncPersistentProjectWorkspace(snapshot, config = loadSelfImprovementConfig()) {
  const mirror = syncProductionSourceMirror(config);
  const workspace = persistentWorkspaceTarget(snapshot, config);
  const evidenceSource = path.join(
    snapshot.run_root,
    config.snapshot_evidence_subdir,
    config.snapshot_runtime_evidence_file_name
  );
  const evidenceTargetDir = path.posix.join(
    workspace,
    config.snapshot_evidence_subdir
  );
  const probe = engineRun(config, [
    'exec',
    '--user', config.persistent_container_user,
    config.persistent_container_name,
    '/bin/sh',
    '-lc',
    'if [ -d ' + shellQuote(path.posix.join(workspace, '.git')) +
      ' ]; then printf initialized; else printf absent; fi'
  ], {
    cwd: config.project_root,
    timeout: config.podman_command_timeout_ms
  });
  const initialized = String(probe.stdout || '').trim() === 'initialized';

  let baseCommit;
  if (!initialized) {
    const rsyncArgs = [
      '-a',
      '--checksum',
      '--prune-empty-dirs',
      '--itemize-changes',
      ...rsyncExcludeArgs(config).map(shellQuote),
      shellQuote(mirror.container_path + '/'),
      shellQuote(workspace + '/')
    ].join(' ');
    const setup = [
      'set -eu',
      'mkdir -p ' + shellQuote(workspace),
      'rsync ' + rsyncArgs,
      'cd ' + shellQuote(workspace),
      sanitizedNpmrcCommand(config),
      'git init -q',
      'git config user.name ' + shellQuote(config.snapshot_git_user_name),
      'git config user.email ' + shellQuote(config.snapshot_git_user_email),
      gitInfoExcludeCommand(config),
      'git add -A -- .',
      'git commit -q -m ' + shellQuote(config.snapshot_git_commit_message),
      'git rev-parse HEAD'
    ].join('; ');
    const initializedResult = engineRun(config, [
      'exec',
      '--user', config.persistent_container_user,
      config.persistent_container_name,
      '/bin/sh',
      '-lc',
      setup
    ], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
    baseCommit = String(initializedResult.stdout || '').trim().split(/\r?\n/).pop();
    appendAudit('persistent_workstation_project_initialized', {
      container: config.persistent_container_name,
      workspace,
      base_commit: baseCommit
    }, config);
  } else {
    const current = engineRun(config, [
      'exec',
      '--user', config.persistent_container_user,
      '--workdir', workspace,
      config.persistent_container_name,
      'git',
      'rev-parse',
      'HEAD'
    ], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
    baseCommit = String(current.stdout || '').trim();
    appendAudit('persistent_workstation_project_preserved', {
      container: config.persistent_container_name,
      workspace,
      base_commit: baseCommit,
      host_mirror_changed_items: mirror.changed_items
    }, config);
  }

  engineRun(config, [
    'exec',
    '--user', config.persistent_container_user,
    config.persistent_container_name,
    '/bin/sh',
    '-lc',
    'mkdir -p ' + shellQuote(evidenceTargetDir)
  ], {
    cwd: config.project_root,
    timeout: config.podman_command_timeout_ms
  });
  if (fs.existsSync(evidenceSource)) {
    engineRun(config, [
      'cp',
      evidenceSource,
      config.persistent_container_name + ':' +
        path.posix.join(
          evidenceTargetDir,
          config.snapshot_runtime_evidence_file_name
        )
    ], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
  }

  return Object.freeze({
    workspace_path: workspace,
    source_mirror_host_path: mirror.host_path,
    source_mirror_container_path: mirror.container_path,
    mirror_changed_items: mirror.changed_items,
    base_commit: baseCommit,
    initialized_now: !initialized,
    preserved_existing_workspace: initialized
  });
}

function inspectPersistentContainer(config = loadSelfImprovementConfig()) {
  const result = spawnSync(
    config.sandbox_engine,
    [
      'inspect',
      '--format',
      '{{json .State.Running}}|{{json .State.StartedAt}}|{{json .ImageName}}|{{json .Image}}',
      config.persistent_container_name
    ],
    {
      cwd: config.project_root,
      encoding: 'utf8',
      timeout: config.podman_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  if (result.status !== 0) {
    return Object.freeze({
      found: false,
      running: false,
      started_at: null,
      image: null
    });
  }
  const [runningRaw, startedRaw, imageRaw, imageIdRaw] = String(result.stdout || '')
    .trim()
    .split('|');
  const startedAt = parseInspectField(startedRaw);
  return Object.freeze({
    found: true,
    running: parseInspectField(runningRaw) === true,
    started_at: typeof startedAt === 'string' ? startedAt : null,
    image: parseInspectField(imageRaw),
    image_id: parseInspectField(imageIdRaw)
  });
}

function buildPersistentSandboxCreateArgs({ config }) {
  const capArgs =
    String(config.cap_drop || '').trim().toLowerCase() === 'none'
      ? []
      : ['--cap-drop', config.cap_drop];
  return [
    'create',
    '--name', config.persistent_container_name,
    '--hostname', config.container_hostname,
    '--user', config.persistent_container_user,
    '--systemd=always',
    '--cgroupns=private',
    '--stop-signal', 'SIGRTMIN+3',
    '--pids-limit', String(config.pids_limit),
    '--memory', String(config.memory_limit),
    '--cpus', String(config.cpu_limit),
    '--network', String(config.network_mode),
    ...capArgs,
    '--security-opt', config.security_opt,
    '--tmpfs', '/run:rw,nosuid,nodev,mode=755',
    '--tmpfs', '/run/lock:rw,nosuid,nodev,mode=755',
    '-v',
    config.workspace_root + ':' +
      config.persistent_workspace_root_mount_path + ':' +
      config.workspace_mount_options,
    '-v',
    config.outbox_root + ':' +
      config.outbox_mount_path + ':' +
      config.outbox_mount_options,
    '-v',
    config.model_proxy_root + ':' +
      config.model_proxy_mount_path + ':' +
      config.model_proxy_mount_options,
    '--mount',
    bindMountSpec(
      persistentSelfContextHostRoot(config),
      config.self_context_mount_path,
      config.self_context_mount_options
    ),
    '--mount',
    bindMountSpec(
      persistentConfigHostRoot(config),
      path.posix.dirname(config.container_config_path),
      config.config_mount_options
    ),
    config.image_name
  ];
}

function syncPersistentAgent(config = loadSelfImprovementConfig()) {
  const files = [
    {
      source: path.join(
        config.project_root,
        'containers',
        'self-improvement',
        'agent.cjs'
      ),
      target: '/opt/floki-self-improvement/agent.cjs'
    },
    {
      source: path.join(
        config.project_root,
        'src',
        'self-improvement',
        'pty-session.cjs'
      ),
      target: '/opt/floki-self-improvement/pty-session.cjs'
    }
  ];
  for (const file of files) {
    if (!fs.existsSync(file.source)) {
      throw new Error('persistent RSI agent source is missing: ' + file.source);
    }
    engineRun(config, [
      'cp',
      file.source,
      config.persistent_container_name + ':' + file.target
    ], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
  }
}

function ensurePersistentContainer(config = loadSelfImprovementConfig()) {
  if (config.persistent_container_enabled !== true) {
    throw new Error('persistent RSI sandbox must be enabled');
  }

  fs.mkdirSync(config.workspace_root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.outbox_root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.model_proxy_root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.runtime_root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(persistentSelfContextHostRoot(config), {
    recursive: true,
    mode: 0o700
  });
  fs.mkdirSync(persistentConfigHostRoot(config), {
    recursive: true,
    mode: 0o700
  });

  ensureImage(config);
  const expectedImageId = inspectImageId(config);
  let state = inspectPersistentContainer(config);
  let provisioned = false;
  const current = readCurrentContainer(config);
  const containerStale =
    state.found &&
    expectedImageId &&
    state.image_id &&
    state.image_id !== expectedImageId;
  if (containerStale) {
    // A real workstation is never deleted merely because its bootstrap image
    // changed. Its writable OS, installed packages, caches, and /home/floki are
    // authoritative persistent state. Image drift is surfaced for deliberate
    // Maker-controlled maintenance instead of destructive reprovisioning.
    appendAudit('persistent_sandbox_image_drift_preserved', {
      container: config.persistent_container_name,
      running_image: state.image_id,
      bootstrap_image: expectedImageId
    }, config);
  }
  if (!state.found) {
    engineRun(config, buildPersistentSandboxCreateArgs({ config }), {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
    provisioned = true;
    state = inspectPersistentContainer(config);
    if (!state.found) {
      throw new Error('persistent RSI sandbox provisioning did not create container');
    }
    appendAudit('persistent_sandbox_provisioned', {
      container: config.persistent_container_name,
      image: config.image_name
    }, config);
  }

  syncPersistentAgent(config);
  return Object.freeze({
    container: config.persistent_container_name,
    provisioned,
    running: state.running,
    image: state.image
  });
}

function ensurePersistentContainerRunning(config = loadSelfImprovementConfig()) {
  const ensured = ensurePersistentContainer(config);
  let state = inspectPersistentContainer(config);
  if (!state.running) {
    engineRun(config, ['start', config.persistent_container_name], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
    state = inspectPersistentContainer(config);
  }
  if (!state.running) {
    throw new Error('persistent RSI sandbox failed to start');
  }
  waitForWorkstationSystemdReady(config);
  ensureWorkstationSystemdBus(config);
  return Object.freeze({ ...ensured, running: true, started_at: state.started_at });
}

function waitForWorkstationSystemdReady(config = loadSelfImprovementConfig()) {
  const deadline = Date.now() + config.workstation_systemd_ready_timeout_ms;
  let lastState = null;
  while (Date.now() <= deadline) {
    const result = workstationExec(config, 'systemctl is-system-running', {
      timeout: config.workstation_systemd_ready_poll_ms +
        config.run_unit_stop_timeout_ms
    });
    lastState = String(result.stdout || '').trim();
    if (lastState === 'running' || lastState === 'degraded') {
      return Object.freeze({ ok: true, state: lastState });
    }
    spawnSync('sleep', [
      String(config.workstation_systemd_ready_poll_ms / 1000)
    ], { timeout: config.workstation_systemd_ready_poll_ms + 5000 });
  }
  throw new Error(
    'workstation systemd did not become ready: ' + String(lastState)
  );
}

// uid 0 in the workstation is named "floki"; the stock D-Bus policy only lets
// the user literally named "root" own org.freedesktop.systemd1, which blocks
// PID 1 from joining the system bus and breaks transient systemd-run units.
// The bootstrap image carries the override; existing workstations self-heal
// here without any destructive reprovisioning.
const WORKSTATION_DBUS_POLICY_PATH =
  '/etc/dbus-1/system.d/floki-uid0-systemd.conf';

function ensureWorkstationSystemdBus(config = loadSelfImprovementConfig()) {
  const owned = workstationExec(
    config,
    'busctl list --no-pager 2>/dev/null | grep -E "^org.freedesktop.systemd1[[:space:]]+[0-9]" >/dev/null'
  );
  if (owned.status === 0) return Object.freeze({ ok: true, repaired: false });

  const policy = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    '<busconfig>',
    '  <policy user="floki">',
    '    <allow own="org.freedesktop.systemd1"/>',
    '    <allow own="org.freedesktop.login1"/>',
    '    <allow send_destination="org.freedesktop.systemd1"/>',
    '    <allow receive_sender="org.freedesktop.systemd1"/>',
    '  </policy>',
    '</busconfig>'
  ].join('\n') + '\n';
  const repair = workstationExec(
    config,
    'mkdir -p /etc/dbus-1/system.d' +
      ' && printf %s ' + shellQuote(policy) +
      ' > ' + shellQuote(WORKSTATION_DBUS_POLICY_PATH) +
      ' && { systemctl reload dbus 2>/dev/null || systemctl restart dbus; }' +
      ' && systemctl daemon-reexec' +
      ' && sleep 2' +
      ' && busctl list --no-pager 2>/dev/null | grep -E "^org.freedesktop.systemd1[[:space:]]+[0-9]" >/dev/null'
  );
  if (repair.status !== 0) {
    throw new Error(
      'workstation systemd bus repair failed; transient run units are unavailable: ' +
      String(repair.stderr || repair.stdout || '').trim()
    );
  }
  appendAudit('workstation_systemd_bus_repaired', {
    container: config.persistent_container_name,
    policy_path: WORKSTATION_DBUS_POLICY_PATH
  }, config);
  return Object.freeze({ ok: true, repaired: true });
}

function workstationProofRecordFile(config = loadSelfImprovementConfig()) {
  return path.join(
    config.runtime_root,
    config.workstation_proof_record_file_name
  );
}

// The persistence proof is an in-container file whose value must survive
// runtime start/stop/reset, preemption, nightly training, REM handoffs, and
// system restarts. The first observation is recorded on the host; every later
// verification must match it exactly.
function verifyWorkstationPersistenceProof(config = loadSelfImprovementConfig()) {
  const result = workstationExec(
    config,
    'cat ' + shellQuote(config.workstation_persistence_proof_path)
  );
  const observed = String(result.stdout || '').trim();
  if (result.status !== 0 || !observed) {
    throw new Error(
      'workstation persistence proof is missing or unreadable: ' +
      config.workstation_persistence_proof_path
    );
  }
  const recordFile = workstationProofRecordFile(config);
  const existing = fs.existsSync(recordFile)
    ? JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    : null;
  if (existing && existing.proof && existing.proof !== observed) {
    throw new Error(
      'workstation persistence proof changed: recorded ' +
      existing.proof + ' but observed ' + observed
    );
  }
  if (!existing || !existing.proof) {
    atomicJson(recordFile, {
      marker: 'FLOKI_V2_RSI_WORKSTATION_PERSISTENCE_PROOF',
      proof: observed,
      proof_path: config.workstation_persistence_proof_path,
      recorded_at: new Date().toISOString()
    }, config);
  }
  return Object.freeze({
    ok: true,
    proof: observed,
    recorded: !existing || !existing.proof
  });
}

function verifyWorkstationStorageMounted(config = loadSelfImprovementConfig()) {
  const mountPath = String(config.workstation_storage_mount_path || '').trim();
  if (!mountPath) {
    return Object.freeze({ ok: true, checked: false });
  }
  const result = spawnSync('mountpoint', ['-q', mountPath], {
    encoding: 'utf8',
    timeout: config.container_stop_command_timeout_ms
  });
  if (result.status !== 0) {
    throw new Error(
      'workstation persistent storage is not mounted: ' + mountPath
    );
  }
  return Object.freeze({ ok: true, checked: true, mount_path: mountPath });
}

// The complete runtime-start contract for the permanent workstation:
// storage mounted, same container started, systemd ready, project workspace
// present, persistence proof unchanged. Never reprovisions an existing
// workstation and never rebuilds the bootstrap image when fingerprints match.
function startWorkstation(config = loadSelfImprovementConfig()) {
  const storage = verifyWorkstationStorageMounted(config);
  const started = ensurePersistentContainerRunning(config);
  const workspace = persistentWorkspaceTarget(null, config);
  const workspaceProbe = workstationExec(
    config,
    'test -d ' + shellQuote(workspace)
  );
  if (workspaceProbe.status !== 0) {
    workstationExec(config, 'mkdir -p ' + shellQuote(workspace));
  }
  const proof = verifyWorkstationPersistenceProof(config);
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_RSI_WORKSTATION_START_PASS',
    container: config.persistent_container_name,
    storage_checked: storage.checked === true,
    started_at: started.started_at,
    workspace,
    persistence_proof: proof.proof
  });
}

function preparePersistentSandboxInputs(snapshot, hostConfigFile, config) {
  const selfContextHostRoot = persistentSelfContextHostRoot(config);
  const configHostRoot = persistentConfigHostRoot(config);
  const configHostFile = persistentConfigHostFile(config);

  clearDirectoryContents(selfContextHostRoot);
  if (fs.existsSync(snapshot.self_context_dir)) {
    fs.cpSync(snapshot.self_context_dir, selfContextHostRoot, {
      recursive: true,
      force: true,
      preserveTimestamps: true
    });
  } else {
    fs.mkdirSync(selfContextHostRoot, { recursive: true, mode: 0o700 });
  }

  clearDirectoryContents(configHostRoot);
  if (fs.existsSync(hostConfigFile)) {
    fs.copyFileSync(hostConfigFile, configHostFile);
    fs.chmodSync(configHostFile, 0o600);
  } else {
    fs.writeFileSync(configHostFile, '{}\n', { mode: 0o600 });
  }
}

function buildPersistentSandboxExecArgs({
  containerName,
  snapshot,
  hostConfigFile,
  config
}) {
  const workspaceTarget = persistentWorkspaceTarget(snapshot, config);
  const unit = agentRunUnitName(snapshot.run_id, config);

  const setup = [
    'set -eu',
    'mkdir -p ' + shellQuote(config.agent_home_path),
    'mkdir -p ' + shellQuote(config.agent_npm_cache_path),
    'mkdir -p ' + shellQuote(config.agent_pip_cache_path),
    'test -d ' + shellQuote(config.self_context_mount_path),
    'test -f ' + shellQuote(config.container_config_path),
    'exec node /opt/floki-self-improvement/agent.cjs'
  ].join('; ');

  // The agent runs inside a run-scoped transient systemd unit so ordinary
  // stop operations (pause, abort, preemption, handoffs) terminate exactly
  // this run's control group and never the workstation container.
  // --pipe/--wait keep the host attached to stdout/stderr and propagate the
  // real exit code; --collect unloads the unit after it ends.
  return [
    'exec',
    '--user', config.persistent_container_user,
    containerName,
    'systemd-run',
    '--quiet',
    '--unit=' + unit,
    '--pipe',
    '--wait',
    '--collect',
    '--property=KillMode=control-group',
    '--working-directory=' + workspaceTarget,
    '--setenv=HOME=' + config.agent_home_path,
    '--setenv=NPM_CONFIG_CACHE=' + config.agent_npm_cache_path,
    '--setenv=PIP_CACHE_DIR=' + config.agent_pip_cache_path,
    '--setenv=FLOKI_RSI_CONFIG_FILE=' + config.container_config_path,
    '--setenv=FLOKI_LEGACY_WORKSPACE_PATH=' + config.workspace_mount_path,
    '/bin/sh', '-c', setup
  ];
}

// Compatibility export retained for narrow callers. It now constructs an exec
// into the persistent container rather than an ephemeral `podman run --rm`.
function buildSandboxRunArgs({ containerName, snapshot, hostConfigFile, config }) {
  return buildPersistentSandboxExecArgs({
    containerName: containerName || config.persistent_container_name,
    snapshot,
    hostConfigFile,
    config
  });
}


// Only dependency-relevant manifest fields participate in the cache
// identity: unrelated package.json edits (npm scripts, description,
// formatting, key order) must not invalidate the seeded node_modules cache,
// while any genuine dependency-resolution change must. package-lock.json is
// hashed byte-for-byte because it is dependency-resolution data in full.
const DEPENDENCY_MANIFEST_FIELDS = Object.freeze([
  'packageManager',
  'engines',
  'devEngines',
  'os',
  'cpu',
  'workspaces',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions'
]);

function stableJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function dependencyManifestFingerprintInput(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    // An unparseable manifest participates byte-for-byte so a broken file
    // can never silently reuse a cache seeded from a healthy one.
    return fs.readFileSync(file);
  }
  const relevant = {};
  for (const field of DEPENDENCY_MANIFEST_FIELDS) {
    if (manifest && manifest[field] !== undefined) {
      relevant[field] = manifest[field];
    }
  }
  return Buffer.from(stableJson(relevant));
}

function dependencyLockFingerprintInput(file) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return fs.readFileSync(file);
  }
  return Buffer.from(stableJson({
    lockfileVersion: lock.lockfileVersion,
    requires: lock.requires,
    packages: lock.packages,
    dependencies: lock.dependencies
  }));
}

function dependencySeedFingerprint(projectDir, algorithm) {
  const hash = crypto.createHash(algorithm);
  hash.update('node_abi');
  hash.update('\0');
  hash.update(String(process.versions.modules || 'unknown'));
  hash.update('\0');
  hash.update('platform');
  hash.update('\0');
  hash.update(process.platform + '-' + process.arch);
  hash.update('\0');
  let files = 0;
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(projectDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(
      name === 'package.json'
        ? dependencyManifestFingerprintInput(file)
        : dependencyLockFingerprintInput(file)
    );
    hash.update('\0');
    files += 1;
  }
  if (files === 0) {
    throw new Error(
      'dependency seed has no package manifest: ' + projectDir
    );
  }
  return hash.digest('hex');
}

function dependencyTreeRequired(projectDir) {
  return dependencyManifestRequiresNodeModules(projectDir);
}

function dependencyCacheCheckScript(config, cacheDir, fingerprint, project) {
  const markerFile = path.posix.join(
    cacheDir,
    config.persistent_dependency_cache_marker_file
  );
  const nodeModules = path.posix.join(cacheDir, 'node_modules');
  return [
    'node -e ' + shellQuote(
      [
        'const fs=require("fs");',
        'const marker=process.argv[1];',
        'const nodeModules=process.argv[2];',
        'const fingerprint=process.argv[3];',
        'const project=process.argv[4];',
        'let row;',
        'try{row=JSON.parse(fs.readFileSync(marker,"utf8"));}catch(_){process.exit(1)}',
        'if(row.marker!=="FLOKI_V2_RSI_PERSISTENT_DEPENDENCY_CACHE")process.exit(1);',
        'if(row.fingerprint!==fingerprint||row.project!==project)process.exit(1);',
        'if(row.empty_tree===true)process.exit(0);',
        'if(!fs.existsSync(nodeModules)||!fs.statSync(nodeModules).isDirectory())process.exit(1);',
        'if(!fs.existsSync(require("path").join(nodeModules,".package-lock.json")))process.exit(1);'
      ].join('')
    ) + ' ' +
      shellQuote(markerFile) + ' ' +
      shellQuote(nodeModules) + ' ' +
      shellQuote(fingerprint) + ' ' +
      shellQuote(project)
  ].join('');
}

function persistentDependencyCacheReady(
  config,
  cacheDir,
  fingerprint
) {
  const markerFile = path.posix.join(
    cacheDir,
    config.persistent_dependency_cache_marker_file
  );
  const result = spawnSync(
    config.sandbox_engine,
    [
      'exec',
      config.persistent_container_name,
      'sh',
      '-lc',
      dependencyCacheCheckScript(
        config,
        cacheDir,
        fingerprint,
        path.posix.basename(path.posix.dirname(cacheDir)) === 'root'
          ? '.'
          : config.interface_project_path
      )
    ],
    {
      cwd: config.project_root,
      env: process.env,
      encoding: 'utf8',
      timeout: config.podman_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  return result.status === 0;
}

function seedPersistentDependencyCacheEntry(
  config,
  label,
  projectDir,
  options = {}
) {
  const fingerprint = dependencySeedFingerprint(
    projectDir,
    config.dependency_fingerprint_algorithm
  );
  const cacheDir = path.posix.join(
    config.persistent_dependency_cache_root,
    label,
    fingerprint
  );

  if (
    persistentDependencyCacheReady(
      config,
      cacheDir,
      fingerprint
    )
  ) {
    const hit = Object.freeze({
      ok: true,
      cache_hit: true,
      label,
      fingerprint,
      cache_dir: cacheDir
    });
    appendAudit('dependency_cache_hit', hit, config);
    if (typeof options.on_event === 'function') {
      options.on_event('dependency_cache_hit', hit);
    }
    return hit;
  }

  const miss = Object.freeze({
    ok: true,
    cache_hit: false,
    label,
    fingerprint,
    cache_dir: cacheDir
  });
  appendAudit('dependency_cache_seed_start', miss, config);
  if (typeof options.on_event === 'function') {
    options.on_event('dependency_seeding', miss);
  }

  const hostNodeModules = path.join(
    projectDir,
    'node_modules'
  );
  const required = dependencyTreeRequired(
    projectDir
  );

  if (
    required &&
    (
      !fs.existsSync(hostNodeModules) ||
      !fs.statSync(hostNodeModules).isDirectory()
    )
  ) {
    throw new Error(
      'production dependency seed is missing: ' +
      hostNodeModules
    );
  }

  const staging =
    cacheDir +
    '.host-seed-' +
    String(process.pid);

  engineRun(
    config,
    [
      'exec',
      config.persistent_container_name,
      'sh',
      '-lc',
      'rm -rf ' + shellQuote(staging) +
        ' && mkdir -p ' +
        shellQuote(
          path.posix.join(staging, 'node_modules')
        )
    ],
    {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    }
  );

  if (required) {
    engineRun(
      config,
      [
        'cp',
        hostNodeModules + '/.',
        config.persistent_container_name +
          ':' +
          path.posix.join(
            staging,
            'node_modules'
          )
      ],
      {
        cwd: config.project_root,
        timeout: config.image_build_timeout_ms
      }
    );
  }

  const marker = Buffer.from(
    JSON.stringify({
      marker:
        'FLOKI_V2_RSI_PERSISTENT_DEPENDENCY_CACHE',
      project:
        label === 'root'
          ? '.'
          : config.interface_project_path,
      fingerprint,
      empty_tree: !required,
      created_at: new Date().toISOString(),
      source: 'production_host_node_modules'
    }, null, 2) + '\n'
  ).toString('base64');

  engineRun(
    config,
    [
      'exec',
      config.persistent_container_name,
      'sh',
      '-lc',
      'printf %s ' +
        shellQuote(marker) +
        ' | base64 -d > ' +
        shellQuote(
          path.posix.join(
            staging,
            config.persistent_dependency_cache_marker_file
          )
        ) +
        ' && rm -rf ' +
        shellQuote(cacheDir) +
        ' && mkdir -p ' +
        shellQuote(path.posix.dirname(cacheDir)) +
        ' && mv ' +
        shellQuote(staging) +
        ' ' +
        shellQuote(cacheDir)
    ],
    {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    }
  );

  const seeded = Object.freeze({
    ok: true,
    cache_hit: false,
    seeded: true,
    label,
    fingerprint,
    cache_dir: cacheDir,
    empty_tree: !required
  });
  appendAudit(
    'dependency_cache_host_seeded',
    {
      ...seeded,
      source: hostNodeModules
    },
    config
  );
  if (typeof options.on_event === 'function') {
    options.on_event('dependency_cache_seeded', seeded);
  }

  return seeded;
}

function seedPersistentDependencyCaches(
  config = loadFreshSelfImprovementConfig(),
  options = {}
) {
  config = Object.freeze({
    ...loadFreshSelfImprovementConfig(),
    ...(config && typeof config === 'object' ? config : {})
  });
  if (config.persistent_container_enabled !== true) {
    throw new Error(
      'persistent dependency seeding requires the persistent RSI sandbox'
    );
  }

  const root = seedPersistentDependencyCacheEntry(
    config,
    'root',
    config.project_root,
    options
  );
  const interfaceTree = seedPersistentDependencyCacheEntry(
    config,
    'interface',
    path.join(
      config.project_root,
      config.interface_project_path
    ),
    options
  );

  return Object.freeze({
    ok: true,
    root,
    interface: interfaceTree
  });
}

function runSandbox(snapshot, options = {}) {
  const config = options.config || loadSelfImprovementConfig();

  const proxySocket = path.join(
    config.model_proxy_root,
    config.model_proxy_socket_name
  );
  if (!fs.existsSync(proxySocket)) {
    throw new Error('self-improvement model proxy socket is unavailable: ' + proxySocket);
  }

  const containerName = config.persistent_container_name;
  const runUnit = agentRunUnitName(snapshot.run_id, config);
  // Truthful preparation visibility: the run must never sit silently at
  // snapshot_ready while long workstation/dependency/sync work happens.
  // Every boundary is persisted to both status and the structured audit.
  const preparationStartedAt = Date.now();
  let previousPreparationAt = preparationStartedAt;
  const reportPreparationPhase = (phase, detail = {}) => {
    const observedAt = Date.now();
    updateStatus({
      state: 'researching',
      phase,
      current_run_id: snapshot.run_id
    }, config);
    appendAudit('sandbox_preparation_phase', {
      run_id: snapshot.run_id,
      phase,
      observed_at: new Date(observedAt).toISOString(),
      elapsed_ms: observedAt - preparationStartedAt,
      since_previous_ms: observedAt - previousPreparationAt,
      ...detail
    }, config);
    previousPreparationAt = observedAt;
  };
  reportPreparationPhase('workstation_starting');
  const workstation = ensurePersistentContainerRunning(config);
  reportPreparationPhase('workstation_ready', {
    container: containerName,
    started_at: workstation.started_at || null
  });
  reportPreparationPhase('dependency_cache_check');
  reportPreparationPhase('dependency_seeding');
  const dependencyCaches = seedPersistentDependencyCaches(config);
  appendAudit('dependency_cache_summary', {
    run_id: snapshot.run_id,
    root: dependencyCaches.root,
    interface: dependencyCaches.interface
  }, config);
  reportPreparationPhase('project_sync');
  const workspaceSync = syncPersistentProjectWorkspace(snapshot, config);

  const outboxRun = path.join(config.outbox_root, snapshot.run_id);
  fs.rmSync(outboxRun, { recursive: true, force: true });
  fs.mkdirSync(config.outbox_root, { recursive: true, mode: 0o700 });

  const hostConfigFile = path.join(snapshot.run_root, 'agent-config.json');
  const workspaceTarget = workspaceSync.workspace_path;
  fs.writeFileSync(
    hostConfigFile,
    JSON.stringify(
      agentConfig(snapshot, { ...options, workspace_path: workspaceTarget }, config),
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  reportPreparationPhase('agent_sync', {
    workspace: workspaceTarget
  });
  preparePersistentSandboxInputs(snapshot, hostConfigFile, config);

  const args = buildPersistentSandboxExecArgs({
    containerName,
    snapshot,
    hostConfigFile,
    config
  });

  const p = paths(config);
  fs.rmSync(currentContainerStopLock(config), { force: true });
  const runLogFile = path.join(snapshot.run_root, config.sandbox_log_file_name);
  const workerLogFile = path.join(config.runtime_root, config.worker_log_name);
  fs.writeFileSync(runLogFile, '', { mode: 0o600 });

  reportPreparationPhase('transient_unit_starting', {
    unit: runUnit,
    workspace: workspaceTarget
  });
  const child = spawn(config.sandbox_engine, args, {
    cwd: config.project_root,
    env: process.env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // A crashed agent must fail the acknowledgement wait immediately instead
  // of leaving the run silently stuck: `systemd-run --wait` exits with the
  // unit, so a child exit before the unit is seen active means the agent
  // process died during startup.
  let childExit = null;
  child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });

  const record = (chunk) => {
    fs.appendFileSync(runLogFile, chunk);
    fs.appendFileSync(workerLogFile, chunk);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  return Object.freeze({
    child,
    container_name: containerName,
    outbox_run: outboxRun,
    log_file: runLogFile,
    read_error_tail() {
      try {
        const content = fs.readFileSync(runLogFile, 'utf8');
        return content.slice(-config.sandbox_error_tail_chars).trim();
      } catch (_error) {
        return '';
      }
    },
    read_stop_request() {
      return readCurrentStopRequest(config);
    },
    async wait_for_container_start() {
      reportPreparationPhase('sandbox_starting');
      const inspected = await waitForContainerStart(containerName, config);
      const unitState = await waitForRunUnitStart(runUnit, config, {
        agent_exit: () => childExit,
        error_tail: () => {
          try {
            const content = fs.readFileSync(runLogFile, 'utf8');
            return content.slice(-config.sandbox_error_tail_chars).trim();
          } catch (_error) {
            return '';
          }
        }
      });
      reportPreparationPhase('sandbox_acknowledged', {
        unit: runUnit,
        unit_main_pid: unitState.main_pid
      });
      const startedAt = new Date().toISOString();
      atomicJson(p.currentContainerFile, {
        marker: 'FLOKI_V2_SELF_IMPROVEMENT_CONTAINER',
        run_id: snapshot.run_id,
        name: containerName,
        unit: runUnit,
        unit_main_pid: unitState.main_pid,
        persistent: true,
        started_at: startedAt,
        podman_started_at: inspected.started_at,
        podman_running_at_ack: inspected.running === true,
        log_file: runLogFile
      }, config);

      updateStatus({
        state: 'experimenting',
        phase: 'sandbox_agent_running',
        current_run_id: snapshot.run_id,
        current_container: containerName,
        current_objective: options.objective || config.default_objective,
        last_sandbox_log_file: runLogFile
      }, config);
      appendAudit(
        'sandbox_started',
        {
          run_id: snapshot.run_id,
          container: containerName,
          unit: runUnit,
          unit_main_pid: unitState.main_pid,
          persistent: true,
          log_file: runLogFile,
          podman_started_at: inspected.started_at,
          podman_running_at_ack: inspected.running === true
        },
        config
      );
      return inspected;
    },
    cleanup() {
      // The named Ubuntu sandbox intentionally survives. Only the current-run
      // state is cleared. chat.local cleanup stops the container without rm.
      fs.rmSync(p.currentContainerFile, { force: true });
      fs.rmSync(currentContainerStopLock(config), { force: true });
    }
  });
}

module.exports = {
  agentConfig,
  agentRunUnitName,
  buildPersistentSandboxCreateArgs,
  buildPersistentSandboxExecArgs,
  buildSandboxRunArgs,
  claimCurrentStopRequest,
  currentContainerStopLock,
  dependencySeedFingerprint,
  ensureImage,
  ensurePersistentContainer,
  ensurePersistentContainerRunning,
  ensureWorkstationSystemdBus,
  engineRun,
  imageSourceFingerprint,
  inspectContainerStart,
  inspectImageFingerprint,
  inspectPersistentContainer,
  persistentSourceMirrorHostRoot,
  persistentWorkspaceTarget,
  readCurrentContainer,
  readCurrentStopRequest,
  remRunUnitName,
  seedPersistentDependencyCaches,
  runSandbox,
  smokeImage,
  startWorkstation,
  stopActiveRunProcess,
  stopWorkstationContainer,
  syncPersistentProjectWorkspace,
  syncProductionSourceMirror,
  trainingRunUnitName,
  verifyWorkstationPersistenceProof,
  verifyWorkstationStorageMounted,
  waitForContainerStart,
  waitForRunUnitStart,
  waitForWorkstationSystemdReady,
  workstationExec
};
