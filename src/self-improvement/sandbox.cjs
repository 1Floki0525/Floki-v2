'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const { appendAudit, atomicJson, paths, updateStatus } = require('./store.cjs');
const { normalizeRunKind, candidateTypeForKind } = require('./run-kinds.cjs');

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
    reason: current.stop_reason,
    requested_at: current.stop_requested_at
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

function stopCurrentContainer(reason = 'preempted', config = loadSelfImprovementConfig()) {
  const claim = claimCurrentStopRequest(reason, config);
  if (!claim.request || !claim.request.container) return false;
  if (!claim.claimed) return true;

  const result = spawnSync(
    config.sandbox_engine,
    [
      'stop',
      '-t',
      String(config.container_stop_timeout_seconds),
      claim.request.container
    ],
    {
      encoding: 'utf8',
      timeout: config.container_stop_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  appendAudit('sandbox_preempted', {
    container: claim.request.container,
    reason: claim.request.reason,
    requested_at: claim.request.requested_at,
    stop_status: result.status,
    stop_signal: result.signal || null,
    stop_error: result.error ? result.error.message : null
  }, config);
  return true;
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
    iteration_wall_clock_budget_ms:
      config.iteration_wall_clock_budget_ms,
    agent_ollama_request_max_attempts:
      config.agent_ollama_request_max_attempts,
    agent_ollama_request_retry_backoff_ms:
      config.agent_ollama_request_retry_backoff_ms,
    max_command_ms: config.max_command_ms,
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
    selection_rescue_max_attempts: config.selection_rescue_max_attempts,
    selection_rescue_temperature: config.selection_rescue_temperature,
    selection_rescue_thinking_enabled: config.selection_rescue_thinking_enabled,
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
  return path.join(config.runtime_root, 'persistent-self-context');
}

function persistentConfigHostRoot(config = loadSelfImprovementConfig()) {
  return path.join(config.runtime_root, 'persistent-config');
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
  const rsyncArgs = [
    '-a',
    '--checksum',
    '--delete',
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
    'if [ ! -d .git ]; then git init -q; fi',
    'git config user.name ' + shellQuote(config.snapshot_git_user_name),
    'git config user.email ' + shellQuote(config.snapshot_git_user_email),
    gitInfoExcludeCommand(config),
    'if git rev-parse --verify HEAD >/dev/null 2>&1; then has_head=1; else has_head=0; fi',
    'git rm -r --cached --ignore-unmatch .floki-self-improvement node_modules apps/floki-neural-interface/node_modules state secrets >/dev/null 2>&1 || true',
    'git add -A -- .',
    'if [ "$has_head" = 0 ] || ! git diff --cached --quiet --exit-code; then git commit -q -m ' +
      shellQuote(config.snapshot_git_commit_message) + '; fi',
    'git rev-parse HEAD'
  ].join('; ');
  const result = engineRun(config, [
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
        path.posix.join(evidenceTargetDir, config.snapshot_runtime_evidence_file_name)
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
    base_commit: String(result.stdout || '').trim().split(/\r?\n/).pop()
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
  return [
    'create',
    '--name', config.persistent_container_name,
    '--hostname', config.container_hostname,
    '--user', config.persistent_container_user,
    '--pids-limit', String(config.pids_limit),
    '--memory', String(config.memory_limit),
    '--cpus', String(config.cpu_limit),
    '--network', String(config.network_mode),
    '--cap-drop', config.cap_drop,
    '--security-opt', config.security_opt,
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
    '--entrypoint', '/bin/sh',
    config.image_name,
    '-lc', config.persistent_container_idle_command
  ];
}

function syncPersistentAgent(config = loadSelfImprovementConfig()) {
  const source = path.join(
    config.project_root,
    'containers',
    'self-improvement',
    'agent.cjs'
  );
  engineRun(config, [
    'cp',
    source,
    config.persistent_container_name + ':/opt/floki-self-improvement/agent.cjs'
  ], {
    cwd: config.project_root,
    timeout: config.podman_command_timeout_ms
  });
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
    if (current && current.name === config.persistent_container_name) {
      throw new Error(
        'persistent RSI sandbox image changed while a run is active; reprovision when idle'
      );
    }
    engineRun(config, ['rm', '-f', config.persistent_container_name], {
      cwd: config.project_root,
      timeout: config.podman_command_timeout_ms
    });
    state = inspectPersistentContainer(config);
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
  return Object.freeze({ ...ensured, running: true, started_at: state.started_at });
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

  const setup = [
    'set -eu',
    'mkdir -p ' + shellQuote(config.agent_home_path),
    'mkdir -p ' + shellQuote(config.agent_npm_cache_path),
    'mkdir -p ' + shellQuote(config.agent_pip_cache_path),
    'test -d ' + shellQuote(config.self_context_mount_path),
    'test -f ' + shellQuote(config.container_config_path),
    'exec env ' +
      'HOME=' + shellQuote(config.agent_home_path) + ' ' +
      'NPM_CONFIG_CACHE=' + shellQuote(config.agent_npm_cache_path) + ' ' +
      'PIP_CACHE_DIR=' + shellQuote(config.agent_pip_cache_path) + ' ' +
      'FLOKI_RSI_CONFIG_FILE=' + shellQuote(config.container_config_path) + ' ' +
      'FLOKI_LEGACY_WORKSPACE_PATH=' + shellQuote(config.workspace_mount_path) + ' ' +
      'node /opt/floki-self-improvement/agent.cjs'
  ].join('; ');

  return [
    'exec',
    '--user', config.persistent_container_user,
    '--workdir', workspaceTarget,
    containerName,
    '/bin/sh',
    '-lc',
    setup
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
  ensurePersistentContainerRunning(config);
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

  const child = spawn(config.sandbox_engine, args, {
    cwd: config.project_root,
    env: process.env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
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
      const inspected = await waitForContainerStart(containerName, config);
      const startedAt = new Date().toISOString();
      atomicJson(p.currentContainerFile, {
        marker: 'FLOKI_V2_SELF_IMPROVEMENT_CONTAINER',
        run_id: snapshot.run_id,
        name: containerName,
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
  buildPersistentSandboxCreateArgs,
  buildPersistentSandboxExecArgs,
  buildSandboxRunArgs,
  claimCurrentStopRequest,
  currentContainerStopLock,
  ensureImage,
  ensurePersistentContainer,
  ensurePersistentContainerRunning,
  engineRun,
  imageSourceFingerprint,
  inspectContainerStart,
  inspectImageFingerprint,
  inspectPersistentContainer,
  persistentSourceMirrorHostRoot,
  persistentWorkspaceTarget,
  readCurrentContainer,
  readCurrentStopRequest,
  runSandbox,
  smokeImage,
  stopCurrentContainer,
  syncPersistentProjectWorkspace,
  syncProductionSourceMirror,
  waitForContainerStart
};
