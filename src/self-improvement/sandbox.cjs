'use strict';

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

function ensureImage(config = loadSelfImprovementConfig()) {
  const exists = spawnSync(
    config.sandbox_engine,
    ['image', 'exists', config.image_name],
    {
      encoding: 'utf8',
      timeout: config.podman_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  if (exists.status === 0) return config.image_name;

  const containerDir = path.join(config.project_root, 'containers', 'self-improvement');
  engineRun(config, [
    'build',
    '--pull=missing',
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
  appendAudit('sandbox_image_built', { image: config.image_name }, config);
  return config.image_name;
}

function hostEndpoint(endpoint, config) {
  const url = new URL(endpoint);
  const loopback = new Set(splitList(config.loopback_hostnames, ','));
  if (loopback.has(url.hostname)) {
    url.hostname = config.host_gateway_name;
  }
  return url.toString().replace(/\/$/, '');
}

function stopCurrentContainer(reason = 'preempted', config = loadSelfImprovementConfig()) {
  const p = paths(config);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(p.currentContainerFile, 'utf8'));
  } catch (_error) {
    return false;
  }
  if (!current || !current.name) return false;

  spawnSync(
    config.sandbox_engine,
    [
      'stop',
      '-t',
      String(config.container_stop_timeout_seconds),
      current.name
    ],
    {
      encoding: 'utf8',
      timeout: config.container_stop_command_timeout_ms,
      maxBuffer: config.podman_output_buffer_bytes
    }
  );
  appendAudit('sandbox_preempted', { container: current.name, reason }, config);
  return true;
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
    model_name: config.model.name,
    model_endpoint: hostEndpoint(config.model.endpoint, config),
    model_temperature: config.model.temperature,
    model_top_p: config.model.top_p,
    model_timeout_ms: config.model.timeout_ms,
    model_keep_alive: config.model.keep_alive,
    context_window: config.context_window,
    max_agent_iterations: config.max_agent_iterations,
    max_command_ms: config.max_command_ms,
    max_changed_files: config.max_changed_files,
    max_patch_bytes: config.max_patch_bytes,
    verification_commands: verificationCommands(config),
    objective: String(options.objective || config.default_objective),
    general_web_enabled: config.general_web_enabled,
    context7_enabled: config.context7_enabled,
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
    '--add-host', config.host_gateway_name + ':' + config.host_gateway_mapping,
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
    '-e', 'FLOKI_RSI_CONFIG_FILE=' + config.container_config_path,
    config.image_name
  ];

  const p = paths(config);
  atomicJson(p.currentContainerFile, {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_CONTAINER',
    run_id: snapshot.run_id,
    name: containerName,
    started_at: new Date().toISOString()
  }, config);

  updateStatus({
    state: 'experimenting',
    phase: 'sandbox_agent_running',
    current_run_id: snapshot.run_id,
    current_container: containerName,
    current_objective: options.objective || config.default_objective
  }, config);
  appendAudit(
    'sandbox_started',
    { run_id: snapshot.run_id, container: containerName },
    config
  );

  const logFile = path.join(config.runtime_root, config.worker_log_name);
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(config.sandbox_engine, args, {
    cwd: config.project_root,
    env: process.env,
    detached: false,
    stdio: ['ignore', log, log]
  });

  return Object.freeze({
    child,
    container_name: containerName,
    outbox_run: outboxRun,
    cleanup() {
      try { fs.closeSync(log); } catch (_error) {}
      fs.rmSync(p.currentContainerFile, { force: true });
    }
  });
}

module.exports = {
  ensureImage,
  engineRun,
  hostEndpoint,
  runSandbox,
  smokeImage,
  stopCurrentContainer
};
