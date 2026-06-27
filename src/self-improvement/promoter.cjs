'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadSelfImprovementConfig } = require('./config.cjs');
const {
  appendAudit,
  nowIso,
  patchCandidate,
  paths,
  readCandidate,
  updateStatus,
  validId
} = require('./store.cjs');
const { assertCodePatchPromoterAccepts } = require('./run-kinds.cjs');

function splitPipe(value) {
  return String(value).split('|').map((item) => item.trim()).filter(Boolean);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fileSha(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return sha256Buffer(fs.readFileSync(file));
}

function run(command, args, options) {
  if (!options || !Number.isFinite(options.timeout) || !Number.isFinite(options.max_buffer_bytes)) {
    throw new Error('promotion command requires YAML-derived timeout and buffer settings');
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: options.max_buffer_bytes
  });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ok: result.status === 0
  };
}

function commandOptions(config, cwd, timeout = undefined) {
  return {
    cwd,
    timeout: timeout === undefined
      ? config.promotion_command_timeout_ms
      : timeout,
    max_buffer_bytes: config.promotion_output_buffer_bytes
  };
}

function assertRun(result) {
  if (!result.ok) {
    throw new Error(
      result.command + ' failed with status ' + result.status + '\n' +
      result.stdout + '\n' +
      result.stderr
    );
  }
  return result;
}

function pathSafe(relative) {
  const value = String(relative || '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.includes('../') || value === '..') {
    throw new Error('unsafe candidate path: ' + value);
  }
  return value;
}

function validateCandidatePolicy(candidate, config) {
  // The code-patch promoter only handles code_patch candidates. Training
  // (model_adapter) candidates must go through the adapter evaluation/promotion
  // path and are refused here.
  const candidateType = candidate.candidate_type || candidate.kind || 'code_patch';
  assertCodePatchPromoterAccepts(candidateType, config);
  if (!Array.isArray(candidate.changed_files) || candidate.changed_files.length === 0) {
    throw new Error('candidate has no changed files');
  }
  if (candidate.changed_files.length > config.max_changed_files) {
    throw new Error('candidate exceeds max_changed_files');
  }
  if (Buffer.byteLength(candidate.diff || '') > config.max_patch_bytes) {
    throw new Error('candidate exceeds max_patch_bytes');
  }
  if (/^(?:new file mode|old mode) (?:120000|160000)$/m.test(candidate.diff || '')) {
    throw new Error('symlink and Git submodule changes are not allowed');
  }

  const forbiddenPatchPatterns = [
    /--privileged\b/i,
    /--network[=\s]+host\b/i,
    /docker\.sock/i,
    /podman\.sock/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-/i,
    /\bgit\s+restore\b/i,
    /\bsudo\s+/i
  ];
  for (const pattern of forbiddenPatchPatterns) {
    if (pattern.test(candidate.diff)) {
      throw new Error(
        'candidate rejected by promotion policy: forbidden patch pattern ' +
        pattern
      );
    }
  }

  const protectedPrefixes = String(config.protected_path_prefixes)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const relative of candidate.changed_files) {
    const safe = pathSafe(relative);
    if (protectedPrefixes.some((prefix) =>
      safe === prefix ||
      safe.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
    )) {
      throw new Error('candidate modifies protected path: ' + safe);
    }
    if (
      config.allow_existing_test_changes !== true &&
      safe.startsWith('tests/') &&
      candidate.before_hashes &&
      candidate.before_hashes[safe]
    ) {
      throw new Error(
        'candidate modifies an existing test while ' +
        'allow_existing_test_changes is false: ' + safe
      );
    }
  }
}

function verifyBaseHashes(candidate, root) {
  for (const relative of candidate.changed_files || []) {
    const safe = pathSafe(relative);
    const expected = Object.prototype.hasOwnProperty.call(
      candidate.before_hashes || {},
      safe
    )
      ? candidate.before_hashes[safe]
      : undefined;
    if (expected === undefined) {
      throw new Error('candidate missing before hash for ' + safe);
    }
    const actual = fileSha(path.join(root, safe));
    if (actual !== expected) {
      throw new Error(
        'candidate is stale: active file changed since snapshot: ' + safe
      );
    }
  }
}

function copyForStage(source, target, config) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const args = ['-a', '--delete'];
  for (const pattern of splitPipe(config.promotion_stage_exclude_patterns)) {
    args.push('--exclude=' + pattern);
  }
  args.push(source + '/', target + '/');
  assertRun(run(
    'rsync',
    args,
    commandOptions(config, undefined, config.promotion_rsync_timeout_ms)
  ));
}

function ensureTestScriptNotWeakened(beforeRoot, afterRoot) {
  const beforeFile = path.join(beforeRoot, 'package.json');
  const afterFile = path.join(afterRoot, 'package.json');
  if (!fs.existsSync(beforeFile) || !fs.existsSync(afterFile)) return;

  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
  const oldCommand = String(
    before.scripts?.['test:node24'] || before.scripts?.test || ''
  );
  const newCommand = String(
    after.scripts?.['test:node24'] || after.scripts?.test || ''
  );
  const testFiles = [
    ...oldCommand.matchAll(/tests\/[a-zA-Z0-9._/-]+\.cjs/g)
  ].map((match) => match[0]);

  for (const testFile of testFiles) {
    if (!newCommand.includes(testFile)) {
      throw new Error(
        'candidate weakens the existing test chain by removing ' +
        testFile
      );
    }
  }
}

function installCommand(directory, config) {
  const lock = path.join(directory, 'package-lock.json');
  return fs.existsSync(lock)
    ? config.dependency_install_locked_command
    : config.dependency_install_unlocked_command;
}

function runShell(command, cwd, config, timeout = undefined) {
  return run(
    'bash',
    ['-lc', command],
    commandOptions(
      config,
      cwd,
      timeout === undefined ? config.promotion_test_timeout_ms : timeout
    )
  );
}

function prepareDependencies(root, config) {
  const install = (directory) => {
    const packageFile = path.join(directory, 'package.json');
    if (!fs.existsSync(packageFile)) return;
    assertRun(runShell(installCommand(directory, config), directory, config));
  };
  install(root);
  install(path.join(root, config.interface_project_path));
}

function verificationCommands(config) {
  return [
    config.verification_command_1,
    config.verification_command_2,
    config.verification_command_3
  ].filter(Boolean);
}

function runVerification(root, config) {
  const results = [];
  for (const command of verificationCommands(config)) {
    const result = runShell(command, root, config);
    results.push(result);
    if (!result.ok) {
      const error = new Error('verification failed: ' + command);
      error.results = results;
      throw error;
    }
  }
  return results;
}

function applyPatch(root, patchFile, reverse, config) {
  const baseArgs = ['apply', '--binary', '--whitespace=error'];
  if (reverse) baseArgs.push('-R');

  assertRun(run(
    'git',
    [...baseArgs, '--check', patchFile],
    commandOptions(config, root, config.promotion_git_apply_timeout_ms)
  ));
  assertRun(run(
    'git',
    [...baseArgs, patchFile],
    commandOptions(config, root, config.promotion_git_apply_timeout_ms)
  ));
}

function writePromotionResults(candidateId, results, config) {
  const dir = path.join(config.candidate_root, candidateId);
  fs.writeFileSync(
    path.join(dir, 'promotion-results.json'),
    JSON.stringify(results, null, 2) + '\n',
    { mode: 0o600 }
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restartChatLocal(config) {
  await delay(config.promotion_restart_delay_seconds * 1000);
  const restartLog = path.join(config.runtime_root, config.restart_log_name);
  const log = fs.openSync(restartLog, 'a', 0o600);
  const child = spawn(
    'bash',
    ['-lc', config.promotion_restart_command],
    {
      cwd: config.project_root,
      env: process.env,
      detached: true,
      stdio: ['ignore', log, log]
    }
  );
  child.unref();
  fs.closeSync(log);
}

async function promote(candidateId, config = loadSelfImprovementConfig()) {
  const id = validId(candidateId, config);
  const p = paths(config);
  const lockFd = fs.openSync(p.promotionLock, 'wx', 0o600);
  const stageRoot = fs.mkdtempSync(
    path.join(config.runtime_root, config.promotion_stage_prefix)
  );
  const baselineRoot = path.join(stageRoot, 'before');
  const candidateRoot = path.join(stageRoot, 'candidate');
  let runtimeStopped = false;

  const resultRecord = {
    marker: 'FLOKI_V2_SELF_IMPROVEMENT_PROMOTION_RESULTS',
    candidate_id: id,
    started_at: nowIso(),
    stage_verification: [],
    production_verification: [],
    rollback: null,
    ok: false
  };

  try {
    const candidate = readCandidate(id, config);
    if (candidate.status !== 'approved') {
      throw new Error('candidate is not approved');
    }

    const patchFile = path.join(
      config.candidate_root,
      id,
      'changes.diff'
    );
    const patchBytes = fs.readFileSync(patchFile);
    if (sha256Buffer(patchBytes) !== candidate.patch_sha256) {
      throw new Error('candidate patch hash changed');
    }

    validateCandidatePolicy(candidate, config);
    verifyBaseHashes(candidate, config.project_root);
    patchCandidate(id, {
      status: 'validating',
      validation_started_at: nowIso()
    }, config);
    updateStatus({
      state: 'validating',
      phase: 'fresh_host_staging_validation',
      promotion: {
        candidate_id: id,
        state: 'validating',
        started_at: nowIso()
      }
    }, config);

    copyForStage(config.project_root, baselineRoot, config);
    copyForStage(config.project_root, candidateRoot, config);
    assertRun(run(
      'git',
      ['init', '-q'],
      commandOptions(config, candidateRoot)
    ));
    applyPatch(candidateRoot, patchFile, false, config);
    ensureTestScriptNotWeakened(baselineRoot, candidateRoot);
    prepareDependencies(candidateRoot, config);
    resultRecord.stage_verification = runVerification(
      candidateRoot,
      config
    );

    verifyBaseHashes(candidate, config.project_root);
    patchCandidate(id, {
      status: 'deploying',
      deployment_started_at: nowIso()
    }, config);
    updateStatus({
      state: 'deploying',
      phase: 'stopping_active_runtime',
      promotion: {
        candidate_id: id,
        state: 'deploying',
        started_at: nowIso()
      }
    }, config);

    assertRun(runShell(
      config.promotion_cleanup_command,
      config.project_root,
      config,
      config.promotion_cleanup_timeout_ms
    ));
    runtimeStopped = true;

    applyPatch(config.project_root, patchFile, false, config);
    try {
      resultRecord.production_verification = runVerification(
        config.project_root,
        config
      );
    } catch (error) {
      resultRecord.production_verification = error.results || [];
      applyPatch(config.project_root, patchFile, true, config);

      const rollbackBuilds = [
        config.rollback_build_command_1,
        config.rollback_build_command_2
      ].filter(Boolean);
      const rebuildResults = [];
      for (const command of rollbackBuilds) {
        rebuildResults.push(
          runShell(command, config.project_root, config)
        );
      }

      resultRecord.rollback = {
        performed: true,
        completed_at: nowIso(),
        reason: error.message,
        rebuild_results: rebuildResults
      };
      patchCandidate(id, {
        status: 'failed_rolled_back',
        failed_at: nowIso(),
        failure: error.message
      }, config);
      updateStatus({
        state: 'failed_rolled_back',
        phase: 'production_verification_failed',
        last_error: error.message,
        promotion: {
          candidate_id: id,
          state: 'failed_rolled_back'
        }
      }, config);
      throw error;
    }

    resultRecord.ok = true;
    resultRecord.completed_at = nowIso();
    patchCandidate(id, {
      status: 'live',
      live_at: nowIso(),
      promotion_verified: true
    }, config);
    updateStatus({
      state: 'live',
      phase: 'restart_queued',
      last_error: null,
      promotion: {
        candidate_id: id,
        state: 'live',
        completed_at: nowIso()
      }
    }, config);
    appendAudit('candidate_promoted_live', { candidate_id: id }, config);
    writePromotionResults(id, resultRecord, config);
    await restartChatLocal(config);
    return resultRecord;
  } catch (error) {
    resultRecord.error = error.stack || error.message;
    resultRecord.completed_at = nowIso();
    try {
      writePromotionResults(id, resultRecord, config);
    } catch (_writeError) {}

    appendAudit(
      'promotion_failed',
      { candidate_id: id, error: resultRecord.error },
      config
    );

    const current = (() => {
      try { return readCandidate(id, config); } catch (_error) { return null; }
    })();
    if (current && !['failed_rolled_back', 'live'].includes(current.status)) {
      patchCandidate(id, {
        status: 'promotion_failed',
        failed_at: nowIso(),
        failure: error.message
      }, config);
      updateStatus({
        state: 'promotion_failed',
        phase: 'promotion_exception',
        last_error: error.stack || error.message,
        promotion: {
          candidate_id: id,
          state: 'promotion_failed'
        }
      }, config);
    }

    if (runtimeStopped) {
      await restartChatLocal(config);
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    try { fs.closeSync(lockFd); } catch (_error) {}
    fs.rmSync(p.promotionLock, { force: true });
  }
}

async function main() {
  const index = process.argv.indexOf('--candidate');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('--candidate is required');
  }
  await promote(process.argv[index + 1]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_SELF_IMPROVEMENT_PROMOTION_FAIL',
      error: error.stack || error.message
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  applyPatch,
  ensureTestScriptNotWeakened,
  fileSha,
  promote,
  runVerification,
  validateCandidatePolicy,
  verifyBaseHashes
};
