'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runtimePath = path.join(root, 'bin/floki-runtime.sh');
const appPath = path.join(root, 'bin/floki-app.sh');

for (const file of [runtimePath, appPath]) {
  assert.equal(fs.existsSync(file), true, 'missing command: ' + file);
  assert.notEqual(fs.statSync(file).mode & 0o111, 0, 'command is not executable: ' + file);
}

const runtime = fs.readFileSync(runtimePath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');
assert.match(runtime, /getLiveChatConfig/);
assert.match(runtime, /loadSelfImprovementConfig/);
assert.match(runtime, /training_container_name_prefix/);
assert.match(runtime, /hf_rem_container_name_prefix/);
assert.match(runtime, /unloadAllLoaded/);
assert.match(runtime, /floki-chat-start\.sh/);
assert.match(runtime, /floki-chat-stop\.sh/);
assert.match(runtime, /floki-self-improvement-start\.sh/);
assert.match(runtime, /floki-self-improvement-stop\.sh/);
assert.doesNotMatch(runtime, /127\.0\.0\.1:7700/);
assert.doesNotMatch(runtime, /127\.0\.0\.1:11434/);
assert.doesNotMatch(runtime, /floki-qwen/);
assert.match(app, /floki-chat-local-start\.sh/);
assert.match(app, /runtime_autostart=false/);
assert.match(app, /floki\.app/);
assert.doesNotMatch(app, /floki-start\.sh\s+chat\.local/);
console.log('FLOKI_RUNTIME_APP_COMMAND_CONTRACT_PASS');
