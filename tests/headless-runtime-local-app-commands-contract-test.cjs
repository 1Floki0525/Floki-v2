'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.match(process.version, /^v24\./);

const root = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const app = read('bin/floki-app-start.sh');
assert.match(
  app,
  /FLOKI_ELECTRON_SHARED_RUNTIME_CLIENT=1/
);
assert.match(app, /runtime_reused=true/);
assert.doesNotMatch(
  app,
  /floki-start\.sh\s+chat\.local/
);
assert.doesNotMatch(
  app,
  /floki-chat-start\.sh/
);
assert.doesNotMatch(
  app,
  /floki-self-improvement-start\.sh/
);
assert.doesNotMatch(
  app,
  /systemctl\s+--user\s+start\s+.*floki-chat-local-runtime/
);

const start = read(
  'bin/floki-runtime-background-start.sh'
);
assert.match(
  start,
  /systemctl --user start "\$RUNTIME_SERVICE"/
);
assert.match(
  start,
  /floki-sleep-scheduler-start\.sh/
);
assert.match(
  start,
  /floki-self-improvement-start\.sh/
);
assert.match(start, /duplicate_runtime_started=false/);

const stop = read('bin/floki-runtime-shutdown.sh');
assert.match(stop, /floki-app-stop\.sh/);
assert.match(
  stop,
  /floki-self-improvement-stop\.sh/
);
assert.match(
  stop,
  /floki-sleep-scheduler-stop\.sh/
);
assert.match(
  stop,
  /systemctl --user stop "\$RUNTIME_SERVICE"/
);
assert.match(stop, /floki-chat-stop\.sh/);
assert.match(stop, /floki-chat-vision-stop\.sh/);
assert.match(stop, /ollama_stopped=false/);

const electron = read(
  'apps/floki-neural-interface/electron/main.cjs'
);
assert.match(
  electron,
  /FLOKI_ELECTRON_SHARED_RUNTIME_CLIENT/
);
assert.match(
  electron,
  /if \(!SHARED_RUNTIME_CLIENT\)/
);

for (const command of [
  'floki-app',
  'floki-runtime-start',
  'floki-runtime-stop'
]) {
  const text = read(command);
  assert.match(text, /^#!\/usr\/bin\/env bash/);
  assert.match(text, /exec "\$ROOT\/bin\//);
}

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_HEADLESS_RUNTIME_AND_LOCAL_APP_COMMANDS_CONTRACT_PASS',
  app_only_launcher: true,
  background_runtime_start: true,
  full_runtime_shutdown: true,
  duplicate_runtime_prevention: true
}, null, 2));
