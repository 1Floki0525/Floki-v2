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
  assert.match(
    snapshotSource,
    /removeInheritedGitMetadata\(repoDir\)[\s\S]*git', \['init', '-q'\]/,
    'copied Git metadata must be removed before the isolated git init'
  );
  assert.match(
    snapshotSource,
    /initializedGitPath[\s\S]*isDirectory\(\)/,
    'snapshot creation must verify that .git is a local directory'
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

  const environmentCheckIndex = agentSource.indexOf(
    'const environmentCheckResult = await shell('
  );
  const rootInstallIndex = agentSource.indexOf('const rootInstall =');
  const modelLoopIndex = agentSource.indexOf(
    'for (let iteration = 0; iteration < MAX_ITERATIONS'
  );
  assert.ok(
    environmentCheckIndex >= 0,
    'the environment check result assignment must exist'
  );
  assert.ok(
    rootInstallIndex > environmentCheckIndex,
    'the sandbox environment check must complete before dependency installation'
  );
  assert.ok(
    modelLoopIndex > environmentCheckIndex,
    'the sandbox environment check must complete before any model iteration starts'
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
    environment_check_fails_closed: true
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
