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

function removeInheritedGitMetadata(repoDir) {
  const gitPath = path.join(repoDir, '.git');
  fs.rmSync(gitPath, { recursive: true, force: true });
  if (fs.existsSync(gitPath)) {
    throw new Error('failed to remove inherited Git metadata: ' + gitPath);
  }
  return gitPath;
}

function writeSanitizedNpmrc(repoDir, config) {
  const lines = splitPipe(config.snapshot_sanitized_npmrc_lines)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const file = path.join(repoDir, '.npmrc');
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

function safeRelativeName(value) {
  return String(value || '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function textIndexable(file) {
  return /\.(?:md|txt|json|jsonl|yaml|yml|csv|log)$/i.test(file);
}

function selfContextIndexChunkChars(config) {
  const value = Number(config.self_context_index_chunk_chars);
  if (!Number.isFinite(value) || value < 1024) {
    throw new Error('self_context_index_chunk_chars must be a YAML-derived number >= 1024');
  }
  return Math.floor(value);
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        stack.push(path.join(current, name));
      }
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out.sort();
}

function copySelfContextSource(source, target, config) {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    run(
      'rsync',
      ['-a', source + '/', target + '/'],
      commandOptions(config, undefined, config.snapshot_rsync_timeout_ms)
    );
    return true;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    return true;
  }
  return false;
}

function writeSelfContextTextIndex(index, base, file, chunkChars) {
  const content = fs.readFileSync(file, 'utf8');
  let chunks = 0;
  for (let offset = 0; offset < content.length; offset += chunkChars) {
    const chunk = content.slice(offset, offset + chunkChars);
    fs.writeSync(index, JSON.stringify({
      ...base,
      text_indexed: true,
      chunked: true,
      chunk_index: chunks,
      chunk_start: offset,
      chunk_end: offset + chunk.length,
      content: chunk
    }) + '\n');
    chunks += 1;
  }
  if (chunks === 0) {
    fs.writeSync(index, JSON.stringify({
      ...base,
      text_indexed: true,
      chunked: true,
      chunk_index: 0,
      chunk_start: 0,
      chunk_end: 0,
      content: ''
    }) + '\n');
    return 1;
  }
  return chunks;
}

function createSelfContextSnapshot(runRoot, config) {
  const contextRoot = path.join(runRoot, config.self_context_directory_name);
  const filesRoot = path.join(contextRoot, 'files');
  fs.rmSync(contextRoot, { recursive: true, force: true });
  fs.mkdirSync(filesRoot, { recursive: true, mode: 0o700 });

  const stateRoot = path.join(config.project_root, 'state', 'floki');
  const chatRoot = path.join(stateRoot, 'chat');
  const configuredDreamRoot = config.dream_root || (() => {
    try {
      return require('../config/floki-config.cjs')
        .getPathConfig('chat')
        .dream_root;
    } catch (_error) {
      return null;
    }
  })();

  const sources = [
    ['soul', path.join(config.project_root, 'SOUL.md')],
    ['identity_state', path.join(stateRoot, 'identity.json')],
    ['personality_state', path.join(stateRoot, 'personality.json')],
    ['emotional_state', path.join(stateRoot, 'affect.json')],
    ['core_memories', path.join(stateRoot, 'memories')],
    ['chat_memory', path.join(chatRoot, 'memory')],
    ['chat_knowledge', path.join(chatRoot, 'knowledge')],
    ['relationship_history', path.join(chatRoot, 'interface')],
    ['sleep_state', path.join(chatRoot, 'sleep')],
    ['dream_memories_state', path.join(stateRoot, 'dreams')],
    ['dream_memories_external', configuredDreamRoot],
    ['personality_module', path.join(config.project_root, 'brain', 'personality')],
    ['hippocampus_module', path.join(config.project_root, 'brain', 'hippocampus')],
    ['pineal_module', path.join(config.project_root, 'brain', 'pineal')],
    ['emotions_module', path.join(config.project_root, 'brain', 'emotions_base')],
    ['living_continuity_api', path.join(config.project_root, 'src', 'chat', 'living-continuity.cjs')],
    ['memory_substrate_api', path.join(config.project_root, 'src', 'chat', 'chat-memory-substrate.cjs')],
    ['brain_schemas', path.join(config.project_root, 'src', 'brain')],
    ['prior_rsi_candidates', config.candidate_root]
  ].filter(([, source]) => typeof source === 'string' && source.trim());

  const copied = [];
  for (const [label, source] of sources) {
    const absolute = path.resolve(source);
    const target = path.join(filesRoot, label, safeRelativeName(absolute));
    if (copySelfContextSource(absolute, target, config)) {
      copied.push({
        label,
        source_path: absolute,
        snapshot_path: path.relative(contextRoot, target)
      });
    }
  }

  const indexFile = path.join(contextRoot, config.self_context_index_file_name);
  const index = fs.openSync(indexFile, 'w', 0o600);
  let indexedFiles = 0;
  let indexedTextChunks = 0;
  const chunkChars = selfContextIndexChunkChars(config);
  try {
    for (const file of walkFiles(filesRoot)) {
      const stat = fs.statSync(file);
      const relative = path.relative(contextRoot, file);
      const base = {
        path: relative,
        bytes: stat.size,
        sha256: hashFile(file),
        text_indexed: textIndexable(file)
      };
      if (base.text_indexed) {
        indexedFiles += 1;
        indexedTextChunks += writeSelfContextTextIndex(index, base, file, chunkChars);
      } else {
        fs.writeSync(index, JSON.stringify(base) + '\n');
      }
    }
  } finally {
    fs.closeSync(index);
  }

  const manifest = {
    marker: 'FLOKI_V2_SELF_CONTEXT_SNAPSHOT',
    created_at: nowIso(),
    read_only_intent: true,
    mount_enforced_read_only: config.self_context_mount_options.includes('ro'),
    contains_private_memory: true,
    privacy_rule:
      'Do not copy private self-context into public web searches, URLs, external APIs, patches, tests, candidate summaries, or public logs.',
    sources: copied,
    index_file: config.self_context_index_file_name,
    index_chunk_chars: chunkChars,
    indexed_text_files: indexedFiles,
    indexed_text_chunks: indexedTextChunks
  };
  fs.writeFileSync(
    path.join(contextRoot, config.self_context_manifest_file_name),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 }
  );
  return Object.freeze({
    directory: contextRoot,
    manifest_file: path.join(contextRoot, config.self_context_manifest_file_name),
    index_file: indexFile,
    source_count: copied.length,
    indexed_text_files: indexedFiles,
    indexed_text_chunks: indexedTextChunks
  });
}

function createSourceSnapshot(options = {}) {
  const config = options.config || loadSelfImprovementConfig();
  const runId = options.run_id || newRunId(config);
  const runRoot = path.join(config.workspace_root, runId);
  const repoDir = path.join(runRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  const selfContext = createSelfContextSnapshot(runRoot, config);

  const excludes = splitPipe(config.snapshot_exclude_patterns);
  const args = ['-a', '--delete', '--prune-empty-dirs'];
  for (const pattern of excludes) args.push('--exclude=' + pattern);
  args.push(config.project_root + '/', repoDir + '/');
  run('rsync', args, commandOptions(config, undefined, config.snapshot_rsync_timeout_ms));
  removeInheritedGitMetadata(repoDir);
  writeSanitizedNpmrc(repoDir, config);

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
  const initializedGitPath = path.join(repoDir, '.git');
  if (
    !fs.existsSync(initializedGitPath) ||
    !fs.statSync(initializedGitPath).isDirectory()
  ) {
    throw new Error(
      'self-improvement snapshot did not create an isolated Git repository'
    );
  }
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
    self_context_dir: selfContext.directory,
    self_context_manifest_file: selfContext.manifest_file,
    self_context_index_file: selfContext.index_file,
    self_context_source_count: selfContext.source_count,
    self_context_indexed_text_files: selfContext.indexed_text_files,
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
  createSelfContextSnapshot,
  removeInheritedGitMetadata,
  newRunId,
  writeSanitizedNpmrc,
  run,
  splitPipe
};
