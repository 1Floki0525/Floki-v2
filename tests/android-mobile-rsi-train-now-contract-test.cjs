'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const vm = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt'
);
const ui = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt'
);

const runStart = vm.indexOf('fun runRsi(objective: String)');
const trainStart = vm.indexOf('fun trainRsi(objective: String)');

assert.notEqual(runStart, -1);
assert.notEqual(trainStart, -1);
assert.ok(trainStart > runStart);

const runSection = vm.slice(runStart, trainStart);
const trainSection = vm.slice(trainStart);

assert.match(runSection, /\/self-improvement\/run-now/);
assert.match(runSection, /put\(\s*"kind",\s*"code"\s*\)/);
assert.match(trainSection, /\/self-improvement\/run-now/);
assert.match(trainSection, /put\(\s*"kind",\s*"training"\s*\)/);

assert.match(ui, /"Run now"/);
assert.match(ui, /vm\.runRsi\(\s*objective\s*\)/);
assert.match(ui, /"Train now"/);
assert.match(ui, /vm\.trainRsi\(\s*objective\s*\)/);

console.log(
  'FLOKI_ANDROID_MOBILE_RSI_TRAIN_NOW_CONTRACT_PASS'
);
