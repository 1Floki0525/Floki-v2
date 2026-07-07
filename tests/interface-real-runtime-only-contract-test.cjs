'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const bannedVendorToken = ['base', '44'].join('');
const productionRoots = [
  'apps/floki-neural-interface/src',
  'apps/floki-neural-interface/electron',
  'src/runtime',
  'src/self-improvement'
];

function trackedFiles() {
  return childProcess.execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).split('\0').filter(Boolean);
}

function isProductionFile(relative) {
  return productionRoots.some((root) => relative === root || relative.startsWith(root + '/'));
}

function readText(relative) {
  const absolute = path.join(ROOT, relative);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return '';
  return fs.readFileSync(absolute, 'utf8');
}

const tracked = trackedFiles();
const vendorHits = [];
const mockRuntimeHits = [];
const suspiciousMockPatterns = [
  /\bmock(?:Data|Candidates|Dreams|Status|Vision|NeuralStream|Messages|Api|Client)\b/i,
  /(?:from|require\s*\()\s*['"][^'"]*(?:\/mock(?:s)?\/|mock-data|mockData|fixtures?)[^'"]*['"]/i,
  /\buseMockData\b/i,
  /\bfallbackToMock\b/i
];

for (const relative of tracked) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) continue;
  const text = readText(relative);
  if (!text) continue;
  if (text.toLowerCase().includes(bannedVendorToken)) vendorHits.push(relative);
  if (isProductionFile(relative) && suspiciousMockPatterns.some((pattern) => pattern.test(text))) {
    mockRuntimeHits.push(relative);
  }
}

for (const manifest of [
  'package.json',
  'package-lock.json',
  'apps/floki-neural-interface/package.json',
  'apps/floki-neural-interface/package-lock.json'
]) {
  const absolute = path.join(ROOT, manifest);
  if (!fs.existsSync(absolute)) continue;
  const text = fs.readFileSync(absolute, 'utf8').toLowerCase();
  assert.equal(text.includes(bannedVendorToken), false, manifest + ' must not contain the scaffold-vendor dependency');
}

assert.deepEqual(vendorHits, [], 'tracked repository files must contain no scaffold-vendor references');
assert.deepEqual(mockRuntimeHits, [], 'production interface/runtime source must not contain mock-data fallbacks');

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_REAL_RUNTIME_ONLY_CONTRACT_PASS',
  tracked_files_checked: tracked.length,
  vendor_references: 0,
  production_mock_fallbacks: 0,
  real_runtime_only: true
}, null, 2));
