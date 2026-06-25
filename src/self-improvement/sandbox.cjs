'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const { appendAudit, atomicJson, paths, updateStatus } = require('./store.cjs');

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
      '{{.State.Running}} {{.State.StartedAt}}',
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

  const text = String(result.stdout || '').trim();
  const [runningText, ...startedParts] = text.split(/\s+/);
  const startedAt = startedParts.join(' ').trim();
  return Object.freeze({
    found: true,
    running: runningText === 'true',
    started_at:
      startedAt && !startedAt.startsWith('0001-01-01')
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
  return [
    config.verification_command_1,
    config.verification_command_2,
    config.verification_command_3
  ].filter(Boolean);
}

function agentConfig(snapshot, options, config) {
  return {
    run_id: snapshot.run_id,
    workspace_path: config.workspace_mount_path,
    outbox_path: config.outbox_mount_path,
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
    agent_tool_result_max_chars: config.agent_tool_result_max_chars,
    agent_test_output_tail_chars: config.agent_test_output_tail_chars,
    agent_min_command_timeout_ms: config.agent_min_command_timeout_ms,
    agent_fetch_default_timeout_ms: config.agent_fetch_default_timeout_ms,
    agent_fetch_max_timeout_ms: config.agent_fetch_max_timeout_ms,
    agent_fetch_default_max_chars: config.agent_fetch_default_max_chars,
    agent_http_user_agent: config.agent_http_user_agent,
    agent_http_accept: config.agent_http_accept,
    agent_home_path: config.agent_home_path,
    agent_npm_cache_path: config.agent_npm_cache_path,
    agent_pip_cache_path: config.agent_pip_cache_path,
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

function runSandbox(snapshot, options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  ensureImage(config);

  const proxySocket = path.join(
    config.model_proxy_root,
    config.model_proxy_socket_name
  );
  if (!fs.existsSync(proxySocket)) {
    throw new Error('self-improvement model proxy socket is unavailable: ' + proxySocket);
  }

  const safeRunId = snapshot.run_id.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const containerName = config.container_name_prefix + '-' + safeRunId;
  const outboxRun = path.join(config.outbox_root, snapshot.run_id);
  fs.rmSync(outboxRun, { recursive: true, force: true });
  fs.mkdirSync(config.outbox_root, { recursive: true, mode: 0o700 });

  const hostConfigFile = path.join(snapshot.run_root, 'agent-config.json');
  fs.writeFileSync(
    hostConfigFile,
    JSON.stringify(agentConfig(snapshot, options, config), null, 2) + '\n',
    { mode: 0o600 }
  );

  const args = [
    'run',
    '--rm',
    '--name', containerName,
    '--hostname', config.container_hostname,
    '--cap-drop=' + config.cap_drop,
    '--security-opt=' + config.security_opt,
    '--pids-limit', String(config.pids_limit),
    '--memory', String(config.memory_limit),
    '--cpus', String(config.cpu_limit),
    '--network', String(config.network_mode),
    '--tmpfs', config.container_tmp_path + ':' + config.tmpfs_options,
    '-v',
    snapshot.repo_dir + ':' +
      config.workspace_mount_path + ':' +
      config.workspace_mount_options,
    '-v',
    config.outbox_root + ':' +
      config.outbox_mount_path + ':' +
      config.outbox_mount_options,
    '-v',
    hostConfigFile + ':' +
      config.container_config_path + ':' +
      config.config_mount_options,
    '-v',
    config.model_proxy_root + ':' +
      config.model_proxy_mount_path + ':' +
      config.model_proxy_mount_options,
    '-e', 'FLOKI_RSI_CONFIG_FILE=' + config.container_config_path,
    config.image_name
  ];

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
          log_file: runLogFile,
          podman_started_at: inspected.started_at,
          podman_running_at_ack: inspected.running === true
        },
        config
      );
      return inspected;
    },
    cleanup() {
      fs.rmSync(p.currentContainerFile, { force: true });
      fs.rmSync(currentContainerStopLock(config), { force: true });
    }
  });
}

module.exports = {
  agentConfig,
  claimCurrentStopRequest,
  currentContainerStopLock,
  ensureImage,
  engineRun,
  imageSourceFingerprint,
  inspectContainerStart,
  inspectImageFingerprint,
  readCurrentContainer,
  readCurrentStopRequest,
  runSandbox,
  smokeImage,
  stopCurrentContainer,
  waitForContainerStart
};
