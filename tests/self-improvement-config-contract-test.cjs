'use strict';

const assert = require('node:assert/strict');
const {
  getSelfImprovementConfig
} = require('../src/config/floki-config.cjs');
const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');

const raw = getSelfImprovementConfig('chat');

const requiredBooleanKeys = [
  'enabled',
  'auto_start',
  'approval_required',
  'general_web_enabled',
  'context7_enabled',
  'allow_existing_test_changes',
  'ollama_stream'
];

const requiredNumberKeys = [
  'idle_seconds',
  'poll_ms',
  'cooldown_seconds',
  'worker_preemption_poll_ms',
  'ui_poll_ms',
  'context_window',
  'max_agent_iterations',
  'max_command_ms',
  'max_changed_files',
  'max_patch_bytes',
  'minimum_available_memory_mb',
  'candidate_id_max_length',
  'approval_token_bytes',
  'atomic_temp_random_bytes',
  'run_id_random_bytes',
  'prior_candidate_history_limit',
  'container_stop_timeout_seconds',
  'container_stop_command_timeout_ms',
  'podman_command_timeout_ms',
  'podman_output_buffer_bytes',
  'image_build_timeout_ms',
  'cpu_limit',
  'pids_limit',
  'snapshot_command_timeout_ms',
  'snapshot_rsync_timeout_ms',
  'snapshot_output_buffer_bytes',
  'promotion_test_timeout_ms',
  'promotion_command_timeout_ms',
  'promotion_output_buffer_bytes',
  'promotion_rsync_timeout_ms',
  'promotion_git_apply_timeout_ms',
  'promotion_cleanup_timeout_ms',
  'promotion_restart_delay_seconds',
  'agent_shell_output_buffer_bytes',
  'agent_git_output_buffer_bytes',
  'agent_git_show_buffer_bytes',
  'agent_command_audit_max_chars',
  'agent_tool_result_max_chars',
  'agent_test_output_tail_chars',
  'agent_min_command_timeout_ms',
  'agent_fetch_default_timeout_ms',
  'agent_fetch_max_timeout_ms',
  'agent_fetch_default_max_chars',
  'browser_virtual_time_budget_ms',
  'browser_timeout_ms',
  'browser_output_buffer_bytes',
  'browser_default_max_chars',
  'browser_max_chars',
  'web_search_default_limit',
  'web_search_max_limit',
  'web_search_max_chars',
  'github_search_default_limit',
  'github_search_max_limit',
  'github_search_max_chars',
  'arxiv_search_default_limit',
  'arxiv_search_max_limit',
  'arxiv_search_max_chars',
  'arxiv_summary_max_chars',
  'crossref_search_default_limit',
  'crossref_search_max_limit',
  'crossref_search_max_chars',
  'context7_call_timeout_ms',
  'service_start_attempts',
  'service_start_poll_seconds',
  'service_start_log_tail_lines',
  'service_stop_attempts',
  'service_stop_poll_seconds'
];

const requiredStringKeys = [
  'run_id_prefix',
  'sandbox_engine',
  'image_name',
  'container_base_image',
  'container_apt_packages',
  'context7_package_name',
  'context7_package_version',
  'container_hostname',
  'container_name_prefix',
  'workspace_mount_path',
  'outbox_mount_path',
  'container_config_path',
  'container_tmp_path',
  'tmpfs_options',
  'network_mode',
  'host_gateway_name',
  'host_gateway_mapping',
  'loopback_hostnames',
  'cap_drop',
  'security_opt',
  'workspace_mount_options',
  'outbox_mount_options',
  'config_mount_options',
  'memory_limit',
  'container_smoke_command',
  'workspace_root',
  'candidate_root',
  'outbox_root',
  'runtime_root',
  'status_file_name',
  'worker_pid_file_name',
  'pause_file_name',
  'run_request_file_name',
  'current_container_file_name',
  'audit_file_name',
  'approval_token_file_name',
  'promotion_lock_file_name',
  'worker_log_name',
  'promotion_log_name',
  'restart_log_name',
  'snapshot_metadata_file_name',
  'snapshot_evidence_subdir',
  'snapshot_runtime_evidence_file_name',
  'snapshot_exclude_patterns',
  'snapshot_git_user_name',
  'snapshot_git_user_email',
  'snapshot_git_commit_message',
  'protected_path_prefixes',
  'verification_command_1',
  'verification_command_2',
  'verification_command_3',
  'promotion_stage_prefix',
  'promotion_stage_exclude_patterns',
  'promotion_cleanup_command',
  'promotion_restart_command',
  'dependency_install_locked_command',
  'dependency_install_unlocked_command',
  'interface_project_path',
  'rollback_build_command_1',
  'rollback_build_command_2',
  'agent_http_user_agent',
  'agent_http_accept',
  'agent_home_path',
  'agent_npm_cache_path',
  'agent_pip_cache_path',
  'browser_command',
  'browser_profile_root',
  'browser_profile_prefix',
  'browser_flags',
  'web_search_url_template',
  'web_search_redirect_base_url',
  'github_search_url_template',
  'github_accept',
  'arxiv_search_url_template',
  'arxiv_accept',
  'crossref_search_url_template',
  'crossref_accept',
  'context7_protocol_version',
  'context7_client_name',
  'context7_client_version',
  'ollama_chat_path',
  'default_objective'
];

for (const key of requiredBooleanKeys) {
  assert.equal(typeof raw[key], 'boolean', key + ' must be YAML boolean');
}
for (const key of requiredNumberKeys) {
  assert.equal(
    typeof raw[key],
    'number',
    key + ' must be YAML number'
  );
  assert.equal(
    Number.isFinite(raw[key]),
    true,
    key + ' must be finite'
  );
}
for (const key of requiredStringKeys) {
  assert.equal(
    typeof raw[key],
    'string',
    key + ' must be YAML string'
  );
  assert.notEqual(raw[key].trim(), '', key + ' must not be empty');
}

assert.notEqual(raw.network_mode, 'host');

const config = loadSelfImprovementConfig();
assert.equal(config.model.name.length > 0, true);
assert.equal(typeof config.model.temperature, 'number');
assert.equal(typeof config.model.top_p, 'number');
assert.equal(typeof config.model.timeout_ms, 'number');
assert.equal(typeof config.model.keep_alive, 'string');
assert.equal(config.workspace_root.startsWith(config.project_root), true);
assert.equal(config.candidate_root.startsWith(config.project_root), true);
assert.equal(config.runtime_root.startsWith(config.project_root), true);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_CONFIG_CONTRACT_PASS'
}, null, 2));
