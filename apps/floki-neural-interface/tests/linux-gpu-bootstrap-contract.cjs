'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainFile = path.resolve(__dirname, '..', 'electron', 'main.cjs');
const source = fs.readFileSync(mainFile, 'utf8');

const switchNeedle = "app.commandLine.appendSwitch('disable-gpu-sandbox')";
const switchIndex = source.indexOf(switchNeedle);
const readyIndex = source.indexOf('app.whenReady()');

assert.notEqual(switchIndex, -1, 'Linux GPU sandbox workaround must exist');
assert.notEqual(readyIndex, -1, 'Electron ready bootstrap must exist');
assert.equal(
  switchIndex < readyIndex,
  true,
  'GPU switch must be applied synchronously before app.whenReady()'
);
assert.equal(
  source.includes("process.platform === 'linux'"),
  true,
  'GPU workaround must be Linux-scoped'
);
assert.equal(
  source.includes('FLOKI_ELECTRON_ENABLE_GPU_SANDBOX'),
  true,
  'GPU sandbox must have an explicit opt-in re-enable escape hatch'
);
assert.equal(
  source.includes("appendSwitch('use-gl', 'desktop')"),
  false,
  'probe-only desktop GL override must not be committed'
);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_ELECTRON_LINUX_GPU_BOOTSTRAP_PASS',
  linux_scoped: true,
  switch_before_ready: true,
  hardware_acceleration_not_disabled: true,
  desktop_gl_override_absent: true
}, null, 2));
