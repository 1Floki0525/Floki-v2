'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  removeInheritedGitMetadata
} = require(path.join(ROOT, 'src/self-improvement/snapshot.cjs'));

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'floki-rsi-snapshot-git-isolation-')
);

try {
  const worktreeStyle = path.join(tempRoot, 'worktree-style');
  fs.mkdirSync(worktreeStyle, { recursive: true });
  fs.writeFileSync(
    path.join(worktreeStyle, '.git'),
    'gitdir: /host/repo/.git/worktrees/stale-worktree\n'
  );
  removeInheritedGitMetadata(worktreeStyle);
  assert.equal(
    fs.existsSync(path.join(worktreeStyle, '.git')),
    false,
    'copied .git worktree pointer file must be removed'
  );

  const directoryStyle = path.join(tempRoot, 'directory-style');
  fs.mkdirSync(path.join(directoryStyle, '.git', 'objects'), {
    recursive: true
  });
  fs.writeFileSync(path.join(directoryStyle, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  removeInheritedGitMetadata(directoryStyle);
  assert.equal(
    fs.existsSync(path.join(directoryStyle, '.git')),
    false,
    'copied .git directory must be removed'
  );

  const snapshotSource = fs.readFileSync(
    path.join(ROOT, 'src/self-improvement/snapshot.cjs'),
    'utf8'
  );
  assert.doesNotMatch(
    snapshotSource,
    /path\.join\(runRoot,\s*['"]repo['"]\)/,
    'snapshot creation must not create a per-run source repository'
  );
  assert.match(
    snapshotSource,
    /persistent_project_workspace_path:\s*config\.persistent_project_workspace_path/,
    'snapshot metadata must point at the persistent sandbox project workspace'
  );

  const agentSource = fs.readFileSync(
    path.join(ROOT, 'containers/self-improvement/agent.cjs'),
    'utf8'
  );
  assert.match(
    agentSource,
    /const environmentCheckResult\s*=\s*await\s+shell\(\s*environmentCheck[\s\S]*environmentCheckResult\.status\s*!==\s*0[\s\S]*sandbox environment check failed/,
    'the RSI agent must capture the sandbox environment check and fail closed on a non-zero status'
  );

  const mainIndex = agentSource.indexOf('async function main()');
  assert.ok(mainIndex >= 0, 'the RSI agent main function must exist');

  const mainSource = agentSource.slice(mainIndex);
  const environmentCheckIndex = mainSource.indexOf(
    'const environmentCheckResult = await shell('
  );
  const rootInstallIndex = mainSource.indexOf('const rootInstall =');

  assert.ok(
    environmentCheckIndex >= 0,
    'the environment check result assignment must exist inside main'
  );
  assert.ok(
    rootInstallIndex > environmentCheckIndex,
    'the sandbox environment check must complete before dependency installation'
  );

  const beforeEnvironmentCheck = mainSource.slice(0, environmentCheckIndex);
  const modelIterationSignals = [
    'OLLAMA_CHAT_PATH',
    'convergencePolicy.beginIteration(',
    'selectionAnchorMessage()',
    'const iterationStartedAt = Date.now()',
    'const messages = ['
  ];

  for (const signal of modelIterationSignals) {
    assert.equal(
      beforeEnvironmentCheck.includes(signal),
      false,
      `model-iteration signal must not occur before the sandbox environment check: ${signal}`
    );
  }

  const modelIterationStartIndexes = modelIterationSignals
    .map((signal) => mainSource.indexOf(signal))
    .filter((index) => index >= 0);

  assert.ok(
    modelIterationStartIndexes.length > 0,
    'the RSI agent must expose at least one model-iteration control-flow signal inside main'
  );
  assert.ok(
    Math.min(...modelIterationStartIndexes) > environmentCheckIndex,
    'the sandbox environment check must complete before model-iteration setup or execution starts'
  );

  for (const file of [
    'config/chat.config.yaml',
    'config/chat.config.yaml.temp'
  ]) {
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    const configText = fs.readFileSync(absolute, 'utf8');
    assert.match(
      configText,
      /snapshot_exclude_patterns: "\.git\|\.git\//,
      `${file} must exclude both a .git worktree pointer file and a .git directory`
    );
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_SNAPSHOT_GIT_ISOLATION_CONTRACT_PASS',
    worktree_pointer_removed: true,
    git_directory_removed: true,
    per_run_source_repository_removed: true,
    environment_check_fails_closed: true
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
