'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const root = path.resolve(app, '..', '..');
const read = (relative) => fs.readFileSync(path.join(app, relative), 'utf8');

assert.equal(fs.existsSync(path.join(app, 'electron/main.cjs')), true);
assert.equal(fs.existsSync(path.join(app, 'electron/preload.cjs')), true);
assert.equal(fs.existsSync(path.join(app, 'dist/index.html')), true);
assert.match(read('package.json'), /"main": "electron\/main\.cjs"/);
assert.doesNotMatch(read('package.json'), /base44|recharts/i);
assert.doesNotMatch(read('vite.config.js'), /base44/i);
assert.doesNotMatch(read('src/pages/SettingsPage.jsx'), /localApiUrl|localWsUrl|loopback REST|local WebSocket/i);
assert.doesNotMatch(read('src/stores/settingsStore.js'), /localApiUrl|localWsUrl|127\.0\.0\.1:7700|\/ws/i);
assert.match(read('src/pages/SettingsPage.jsx'), /Electron IPC/);
assert.match(read('electron/main.cjs'), /handleTypedText/);
assert.match(read('electron/main.cjs'), /readChatTranscriptTail/);
assert.match(read('electron/main.cjs'), /readChatWebcamVisionStatus/);
assert.match(read('electron/main.cjs'), /loadAffectState/);
assert.match(read('electron/main.cjs'), /buildFlokiLifecycleStatus/);
assert.match(fs.readFileSync(path.join(root, 'bin/floki-start.sh'), 'utf8'), /chat\.local/);

const forbidden = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tests'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|jsx|cjs|mjs|json|md|html)$/i.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (/base44|FLOKI_INTEGRATION_PLACEHOLDER|mockAdapter|mockMode/i.test(text)) forbidden.push(path.relative(app, full));
    }
  }
}
walk(app);
assert.deepEqual(forbidden, [], `obsolete generated-platform or mock references remain: ${forbidden.join(', ')}`);
console.log('FLOKI_V2_CHAT_LOCAL_CONTRACT_PASS');
