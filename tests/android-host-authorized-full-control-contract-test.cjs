
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const vm = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt');
const ui = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt');
const backend = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiBackend.kt');

assert.match(vm, /private var accessCredential = ""/);
assert.match(vm, /private suspend fun applyBootstrapSession/);
assert.match(vm, /val gatewaySession = parseSession\(\s*backend\.getSession\(\)\s*\)/);
assert.match(vm, /FULL_HOST_CAPABILITIES/);
assert.match(vm, /self_improvement:control/);
assert.match(vm, /candidate:review/);
assert.match(vm, /system:control/);
assert.match(vm, /runtime:control/);
assert.match(vm, /settings:write/);
assert.match(vm, /profile\.developerMode \|\|\s*accessCredential\.isNotBlank\(\)/);
assert.doesNotMatch(vm, /if \(profile\.sessionCredential\.isNotBlank\(\)\) backend\.getSession\(\)/);
assert.match(vm, /session = gatewaySession/);
assert.match(vm, /current\.session\.copy\(\s*lastError = error\.message\s*\)/);
assert.match(vm, /bootstrapAndStart\(\s*force = true\s*\)/);
assert.doesNotMatch(vm, /Sign in with an account that has it/);
assert.match(backend, /suspend fun getSession\(\)/);
assert.match(ui, /HOST AUTHORIZATION IS RESTORING FULL CONTROL/);
assert.doesNotMatch(ui, /Controls disabled: this account lacks self_improvement:control/);

console.log('FLOKI_ANDROID_HOST_AUTHORIZED_FULL_CONTROL_CONTRACT_PASS');
