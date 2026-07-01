'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const THIS_TEST = 'tests/node24-patch-portability-contract-test.cjs';
const ACTIVE_ROOTS = new Set([
  'bin',
  'src',
  'tests',
  'apps',
  'containers',
  'brain',
  'config'
]);
const activeMajor = Number(process.versions.node.split('.')[0]);

assert.equal(
  Number.isInteger(activeMajor) && activeMajor >= 24,
  true,
  'Node 24 or newer is required'
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);
assert.equal(pkg.engines.node, '>=24');

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
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT }
).toString('utf8').split('\0').filter(Boolean);

const oldEngineRange = ['>=24', '<25'].join(' ');
const exactJsGuards = [
  /process\.version\.startsWith\(\s*['"]v24\./,
  /assert\.match\(\s*process\.version\s*,\s*\/\^v24\\\.\//,
  /\/\^v24\\\.\/\.test\(\s*process\.version/
];
const exactShellGuards = [
  /v24\.\*\)/,
  /\^v24\\\./,
  /node_is_24\(\)/
];

const offenders = [];

for (const relative of tracked) {
  if (relative === THIS_TEST) continue;
  const first = relative.split('/')[0];
  if (!ACTIVE_ROOTS.has(first)) continue;

  let source;
  try {
    source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  } catch {
    continue;
  }

  if (
    /\.(?:cjs|mjs|js|jsx|ts|tsx)$/.test(relative) &&
    exactJsGuards.some((pattern) => pattern.test(source))
  ) {
    offenders.push(relative + ': exact-JavaScript-Node-24 guard');
  }

  if (
    relative.endsWith('.sh') &&
    exactShellGuards.some((pattern) => pattern.test(source))
  ) {
    offenders.push(relative + ': exact-shell-Node-24 guard');
  }

  if (source.includes(oldEngineRange)) {
    offenders.push(relative + ': obsolete-engine-upper-bound');
  }
}

assert.deepEqual(
  offenders,
  [],
  'active code must accept every Node major version 24 or newer'
);

const wrapper = fs.readFileSync(
  path.join(ROOT, 'bin/floki-node24-run.sh'),
  'utf8'
);
assert.match(wrapper, /node_is_24_or_newer/);
assert.match(wrapper, /-ge 24/);
assert.match(wrapper, /nvm use 24/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_NODE24PLUS_COMPLETE_PORTABILITY_PASS',
  active_version: process.version,
  active_major: activeMajor,
  engine_range: pkg.engines.node,
  preferred_baseline: 24,
  offenders: offenders.length,
  active_tree_only: true,
  node_24_or_newer_supported: true
}, null, 2));
