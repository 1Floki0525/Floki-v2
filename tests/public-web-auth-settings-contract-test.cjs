'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const adapter = read('apps/floki-neural-interface/src/integrations/floki/adapter.js');
const settings = read('apps/floki-neural-interface/src/stores/settingsStore.js');

assert.match(adapter, /window\.FLOKI_BOOTSTRAP/);
assert.match(adapter, /'X-WP-Nonce'/);
assert.match(adapter, /credentials:\s*'same-origin'/);
assert.match(adapter, /Authorization\s*=\s*`Bearer \$\{token\}`/);
assert.match(adapter, /ensureWebAuthToken\(forceRefresh = false\)/);
assert.match(adapter, /if \(res\.status === 401 && webBootstrap\(\)\)/);
assert.match(adapter, /clearWebAuthToken\(\)/);
assert.match(adapter, /searchParams\.set\('token', token\)/);
assert.match(adapter, /new WebSocket\(authenticatedWebSocketUrl\(url, token\)\)/);
assert.match(adapter, /runtimeHttpRequest\(\s*'GET',\s*'\/interface\/vision\/frame\/latest\.jpg'/s);
assert.match(adapter, /runtimeHttpRequest\(\s*'POST',\s*'\/interface\/client-app\/heartbeat'/s);
assert.match(adapter, /runtimeHttpRequest\(\s*'POST',\s*'\/interface\/settings\/update'/s);
assert.match(adapter, /runtimeHttpRequest\(\s*'POST',\s*'\/interface\/settings\/reset'/s);
assert.match(adapter, /runtimeHttpRequest\(\s*'POST',\s*'\/interface\/settings\/import'/s);
assert.doesNotMatch(adapter, /localStorage\.setItem\([^)]*(?:token|credential)/i);
assert.doesNotMatch(adapter, /sessionStorage\.setItem\([^)]*(?:token|credential)/i);

assert.match(settings, /import flokiAdapter from '\.\.\/integrations\/floki\/adapter'/);
assert.match(settings, /hasBridge\(\) \? bridge\(\)\.getSettings\(\) : flokiAdapter\.getSettings\(\)/);
assert.match(settings, /flokiAdapter\.updateSettings/);
assert.match(settings, /flokiAdapter\.resetSettings/);
assert.match(settings, /flokiAdapter\.importSettings/);
assert.doesNotMatch(
  settings,
  /initializeSettings\(\)\s*\{\s*if \(!loading\) loading = bridge\(\)\.getSettings/,
);

console.log('FLOKI_PUBLIC_WEB_AUTH_SETTINGS_CONTRACT_PASS');
