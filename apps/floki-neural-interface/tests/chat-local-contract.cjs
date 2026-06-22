'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = path.resolve(__dirname, '..')
const root = path.resolve(app, '..', '..')
const read = (relative) => fs.readFileSync(path.join(app, relative), 'utf8')

assert.equal(fs.existsSync(path.join(app, 'electron/main.cjs')), true)
assert.equal(fs.existsSync(path.join(app, 'electron/preload.cjs')), true)
assert.equal(fs.existsSync(path.join(app, 'dist/index.html')), true)
assert.match(read('package.json'), /"main": "electron\/main\.cjs"/)
assert.doesNotMatch(read('package.json'), /base44|recharts/i)
assert.doesNotMatch(read('vite.config.js'), /base44/i)

const settingsPage = read('src/pages/SettingsPage.jsx')
const settingsStore = read('src/stores/settingsStore.js')
assert.match(settingsPage, /Electron IPC/)
assert.match(settingsPage, /Local API URL/)
assert.match(settingsPage, /Local WebSocket URL/)
assert.match(settingsPage, /Mock Mode/)
assert.match(settingsStore, /mockMode:\s*false/)
assert.match(settingsStore, /localApiUrl/)
assert.match(settingsStore, /localWsUrl/)

const main = read('electron/main.cjs')
assert.doesNotMatch(main, /handleTypedText\s*\(/)
assert.doesNotMatch(main, /createRuntime\s*\(/)
assert.equal(main.includes("runtimeRequest('POST', '/chat'"), true)
assert.match(main, /readChatTranscriptTail/)
assert.match(main, /readChatWebcamVisionStatus/)
assert.match(main, /loadAffectState/)
assert.match(main, /buildFlokiLifecycleStatus/)
assert.match(fs.readFileSync(path.join(root, 'bin/floki-start.sh'), 'utf8'), /chat\.local/)

const forbidden = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tests'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(js|jsx|cjs|mjs|json|md|html)$/i.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8')
      if (/base44|FLOKI_INTEGRATION_PLACEHOLDER/i.test(text)) forbidden.push(path.relative(app, full))
    }
  }
}
walk(app)
assert.deepEqual(forbidden, [], `obsolete generated-platform placeholders remain: ${forbidden.join(', ')}`)
assert.equal(fs.existsSync(path.join(app, 'src/integrations/floki/mockAdapter.js')), false, 'mock adapter must not be active production code')

console.log('FLOKI_V2_CHAT_LOCAL_CONTRACT_PASS')
