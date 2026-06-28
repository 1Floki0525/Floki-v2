'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const stalePatch = ['24', '17', '0'].join('.');

assert.match(process.version, /^v24\./);

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);
assert.equal(pkg.engines.node, '>=24 <25');

assert.equal(
  fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(),
  '24'
);
assert.equal(
  fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim(),
  '24'
);

const tracked = execFileSync(
  'git',
  ['ls-files', '-z'],
  { cwd: ROOT }
).toString('utf8').split('\0').filter(Boolean);

const stalePatchOffenders = [];
const exactVersionCheckOffenders = [];
const shellPatternOffenders = [];

const exactVersionPatterns = [
  /assert\.(?:equal|strictEqual)\(\s*process\.version\s*,\s*['"]v24\.x['"]/s,
  /assert\.(?:equal|strictEqual)\(\s*['"]v24\.x['"]\s*,\s*process\.version/s,
  /process\.version\s*(?:===|!==|==|!=)\s*['"]v24\.x['"]/,
  /['"]v24\.x['"]\s*(?:===|!==|==|!=)\s*process\.version/
];

for (const relative of tracked) {
  const absolute = path.join(ROOT, relative);
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }

  if (source.includes(stalePatch)) {
    stalePatchOffenders.push(relative);
  }

  if (
    /\.(?:cjs|mjs|js)$/.test(relative) &&
    exactVersionPatterns.some((pattern) => pattern.test(source))
  ) {
    exactVersionCheckOffenders.push(relative);
  }

  if (
    relative.endsWith('.sh') &&
    (
      source.includes('v24.x)') ||
      source.includes('nvm use 24.x')
    )
  ) {
    shellPatternOffenders.push(relative);
  }
}

assert.deepEqual(
  stalePatchOffenders,
  [],
  'tracked files must not pin Node to one patch release'
);
assert.deepEqual(
  exactVersionCheckOffenders,
  [],
  'JavaScript must test the Node 24 major version, not equality with v24.x'
);
assert.deepEqual(
  shellPatternOffenders,
  [],
  'shell scripts must use v24.* patterns and nvm use 24'
);

const wrapper = fs.readFileSync(
  path.join(ROOT, 'bin/floki-node24-run.sh'),
  'utf8'
);
assert.match(wrapper, /v24\.\*/);
assert.doesNotMatch(wrapper, /v24\.\d+\.\d+\)/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_NODE24_PATCH_PORTABILITY_PASS',
  active_version: process.version,
  engine_range: pkg.engines.node,
  stale_patch_pins: stalePatchOffenders.length,
  invalid_exact_version_checks: exactVersionCheckOffenders.length,
  invalid_shell_patterns: shellPatternOffenders.length,
  any_node_24_supported: true
}, null, 2));
