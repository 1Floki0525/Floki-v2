'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const { nowIso } = require('./store.cjs');

function run(command, args, options) {
  if (!options || !Number.isFinite(options.timeout) || !Number.isFinite(options.max_buffer_bytes)) {
    throw new Error('snapshot command requires YAML-derived timeout and buffer settings');
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: options.max_buffer_bytes
  });
  if (result.status !== 0) {
    throw new Error(
      command + ' failed with status ' + result.status + '\n' +
      String(result.stdout || '') + '\n' +
      String(result.stderr || '')
    );
  }
  return result;
}

function newRunId(config = loadSelfImprovementConfig()) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const suffix = crypto.randomBytes(config.run_id_random_bytes).toString('hex');
  return config.run_id_prefix + '-' + stamp + '-' + suffix;
}

function splitPipe(value) {
  return String(value).split('|').map((item) => item.trim()).filter(Boolean);
}

function commandOptions(config, cwd = undefined, timeout = undefined) {
  return {
    cwd,
    timeout: timeout === undefined ? config.snapshot_command_timeout_ms : timeout,
    max_buffer_bytes: config.snapshot_output_buffer_bytes
  };
}

function createSourceSnapshot(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const runId = options.run_id || newRunId(config);
  const runRoot = path.join(config.workspace_root, runId);
  const repoDir = path.join(runRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });

  const excludes = splitPipe(config.snapshot_exclude_patterns);
  const args = ['-a', '--delete', '--prune-empty-dirs'];
  for (const pattern of excludes) args.push('--exclude=' + pattern);
  args.push(config.project_root + '/', repoDir + '/');
  run('rsync', args, commandOptions(config, undefined, config.snapshot_rsync_timeout_ms));

  const runtimeStatusFile = path.join(config.chat_runtime_root, 'chat-local-runtime.status.json');
  let runtimeEvidence = null;
  try {
    const status = JSON.parse(fs.readFileSync(runtimeStatusFile, 'utf8'));
    const previousCandidates = [];
    try {
      for (const entry of fs.readdirSync(config.candidate_root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestFile = path.join(config.candidate_root, entry.name, 'manifest.json');
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
          previousCandidates.push({
            id: manifest.id,
            status: manifest.status,
            objective: manifest.objective || null,
            expected_benefit: manifest.expected_benefit || null,
            denial_reason: manifest.denial_reason || null,
            failure: manifest.failure || null,
            created_at: manifest.created_at || null,
            updated_at: manifest.updated_at || null
          });
        } catch (_candidateError) {}
      }
    } catch (_candidateRootError) {}
    previousCandidates.sort((a, b) =>
      String(b.updated_at || b.created_at || '')
        .localeCompare(String(a.updated_at || a.created_at || ''))
    );

    runtimeEvidence = {
      captured_at: nowIso(),
      state: status.state || null,
      ready: status.ready === true,
      active_turn: status.active_turn === true,
      last_error: status.last_error || null,
      hearing_error: status.hearing?.last_error || status.hearing_start_error || null,
      vision_error: status.vision?.last_error || status.vision_start_error || null,
      lifecycle: status.lifecycle ? {
        state: status.lifecycle.state || null,
        is_awake: status.lifecycle.is_awake === true,
        is_dreaming: status.lifecycle.is_dreaming === true
      } : null,
      previous_candidate_outcomes: previousCandidates.slice(
        0,
        config.prior_candidate_history_limit
      )
    };
  } catch (_error) {
    runtimeEvidence = { captured_at: nowIso(), unavailable: true };
  }

  const evidenceDir = path.join(repoDir, config.snapshot_evidence_subdir);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(evidenceDir, config.snapshot_runtime_evidence_file_name),
    JSON.stringify(runtimeEvidence, null, 2) + '\n',
    { mode: 0o600 }
  );

  run('git', ['init', '-q'], commandOptions(config, repoDir));
  run(
    'git',
    ['config', 'user.name', config.snapshot_git_user_name],
    commandOptions(config, repoDir)
  );
  run(
    'git',
    ['config', 'user.email', config.snapshot_git_user_email],
    commandOptions(config, repoDir)
  );
  run('git', ['add', '-A', '--', '.'], commandOptions(config, repoDir));
  run(
    'git',
    ['commit', '-q', '-m', config.snapshot_git_commit_message],
    commandOptions(config, repoDir)
  );
  const baseCommit = run(
    'git',
    ['rev-parse', 'HEAD'],
    commandOptions(config, repoDir)
  ).stdout.trim();

  const metadata = {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_SNAPSHOT',
    run_id: runId,
    created_at: nowIso(),
    source_root: config.project_root,
    run_root: runRoot,
    repo_dir: repoDir,
    base_commit: baseCommit,
    exclusions: excludes
  };
  fs.writeFileSync(
    path.join(runRoot, config.snapshot_metadata_file_name),
    JSON.stringify(metadata, null, 2) + '\n',
    { mode: 0o600 }
  );
  return Object.freeze(metadata);
}

module.exports = {
  createSourceSnapshot,
  newRunId,
  run,
  splitPipe
};
