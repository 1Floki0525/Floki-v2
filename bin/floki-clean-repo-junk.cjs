'use strict';

/**
 * Floki-v2 repo cleanup.
 *
 * Removes temporary patch/backups from git and strengthens .gitignore.
 * Keeps real runtime/proof scripts:
 * - bin/floki-runtime.sh
 * - bin/floki-runtime-proof.sh
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function pathExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function gitTrackedFiles() {
  return run('git', ['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function shouldRemoveTracked(file) {
  if (file === 'bin/floki-clean-repo-junk.cjs') return false;

  if (file.startsWith('.env.bak.')) return true;
  if (file.includes('.bak.')) return true;
  if (file.startsWith('bin/floki-fast-patch-') && file.endsWith('.cjs')) return true;
  if (file.startsWith('brain/thalamum.disabled.')) return true;

  return false;
}

function gitRm(files) {
  if (files.length === 0) return;

  const chunkSize = 50;

  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    execFileSync('git', ['rm', '-r', '--'].concat(chunk), {
      cwd: ROOT,
      stdio: 'inherit'
    });
  }
}

function ensureGitignore() {
  const gitignorePath = path.join(ROOT, '.gitignore');
  const existing = pathExists('.gitignore') ? fs.readFileSync(gitignorePath, 'utf8') : '';

  const block = [
    '',
    '# Floki-v2 local/transient files',
    '.env',
    '.env.*',
    '!.env.example',
    '*.bak.*',
    '*.tmp',
    '*.log',
    'state/',
    'reports/',
    'bin/floki-fast-patch-*.cjs',
    'brain/thalamum.disabled.*/',
    ''
  ].join('\n');

  const needed = [
    '.env.*',
    '*.bak.*',
    'bin/floki-fast-patch-*.cjs',
    'brain/thalamum.disabled.*/'
  ];

  const missing = needed.some((item) => !existing.includes(item));

  if (!missing) {
    return { changed: false };
  }

  fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + block);
  return { changed: true };
}

function main() {
  if (process.cwd() !== ROOT) {
    throw new Error('Run this from ' + ROOT);
  }

  const tracked = gitTrackedFiles();
  const remove = tracked.filter(shouldRemoveTracked);

  gitRm(remove);
  const gitignore = ensureGitignore();

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_REPO_JUNK_CLEANUP_PASS',
    removed_count: remove.length,
    removed: remove,
    gitignore
  }, null, 2));
}

main();
