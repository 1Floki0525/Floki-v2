'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function scanDirectories() {
  const dirs = [
    'src',
    'brain',
    'bin',
    path.join('apps', 'floki-neural-interface', 'electron')
  ];
  return dirs.map(d => path.join(PROJECT_ROOT, d));
}

function collectFiles(rootDirs) {
  const extensions = ['.js', '.cjs', '.mjs'];
  const excludeDirs = ['node_modules', 'dist', 'backups'];
  const files = [];

  for (const dir of rootDirs) {
    if (!fs.existsSync(dir)) continue;

    const walk = (currentDir) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirs.includes(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dir);
  }

  return files;
}

function syntaxCheck(filePath) {
  try {
    spawnSync(process.execPath, ['--check', filePath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30000
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'syntax check failed' };
  }
}

function requireCheck(filePath) {
  try {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(filePath)})`], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, FLOKI_ALLOW_SLEEP_CYCLE: '1', FLOKI_ALLOW_DREAM_ENGINE: '1' }
    });

    if (result.status !== 0) {
      const stderr = result.stderr || result.stdout || '';
      return { ok: false, error: stderr.toString() };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'require check failed' };
  }
}

function main() {
  console.log('Active source preflight check...');
  console.log('Scanning directories:', scanDirectories().map(d => path.relative(PROJECT_ROOT, d)).join(', '));

  const files = collectFiles(scanDirectories());
  console.log(`Found ${files.length} files to check\n`);

  let syntaxErrors = 0;
  let requireErrors = 0;
  let warnings = 0;

  for (const file of files) {
    const relPath = path.relative(PROJECT_ROOT, file);
    const syntaxResult = syntaxCheck(file);

    if (!syntaxResult.ok) {
      console.error(`❌ SYNTAX ERROR: ${relPath}`);
      console.error(`   ${syntaxResult.error}\n`);
      syntaxErrors++;
    } else {
      console.log(`✅ Syntax OK: ${relPath}`);
    }

    if (file.includes('floki-chat.cjs') || file.includes('sleep-cycle.cjs') || file.includes('sleep-cycle-scheduler.cjs')) {
      console.log(`   → Checking require(…) integrity...`);
      const requireResult = requireCheck(file);
      if (!requireResult.ok) {
        console.error(`   ❌ REQUIRE ERROR: ${relPath}`);
        console.error(`   ${requireResult.error}\n`);
        requireErrors++;
      } else {
        console.log(`   ✅ Require OK: ${relPath}`);
      }
    }

    const stderrStr = (syntaxResult.error || '').toLowerCase();
    if (stderrStr.includes('circular') || stderrStr.includes('non-existent property')) {
      console.warn(`   ⚠️  WARNING: ${relPath}`);
      warnings++;
    }
  }

  console.log('\n--- PREFLIGHT RESULTS ---');
  console.log(`Total files: ${files.length}`);
  console.log(`Syntax errors: ${syntaxErrors}`);
  console.log(`Require errors: ${requireErrors}`);
  console.log(`Warnings: ${warnings}`);

  if (syntaxErrors > 0 || requireErrors > 0 || warnings > 0) {
    console.error('\n❌ PREFLIGHT FAILED');
    process.exit(1);
  }

  console.log('\n✅ PREFLIGHT PASSED');
}

if (require.main === module) {
  main();
}

module.exports = { main, scanDirectories, collectFiles };
