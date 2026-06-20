'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const app = path.resolve(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(app, relative), 'utf8')

const settingsPage = read('src/pages/SettingsPage.jsx')
const settingsStore = read('src/stores/settingsStore.js')
const systemControls = read('src/components/system/SystemControls.jsx')
const main = read('electron/main.cjs')

const settingsSections = [
  'Connection',
  'Chat',
  'Voice',
  'Vision',
  'Emotions',
  'Neural Stream',
  'Appearance',
  'Latency',
  'Privacy',
]

for (const section of settingsSections) {
  assert.match(settingsPage, new RegExp(`title=["']${section}["']`), `missing settings section: ${section}`)
}

for (const key of ['connection', 'chat', 'voice', 'vision', 'emotions', 'neuralStream', 'appearance', 'latency', 'privacy']) {
  assert.match(settingsStore, new RegExp(`\\b${key}:\\s*\\{`), `missing settings store section: ${key}`)
}

const controls = [
  'startChat',
  'stopChat',
  'restartChat',
  'wake',
  'requestSleep',
  'pauseSleep',
  'resumeSleep',
  'restartVision',
  'restartHearing',
  'restartSpeech',
  'interrupt',
]

for (const action of controls) {
  assert.match(systemControls, new RegExp(`id:\\s*["']${action}["']`), `missing system control: ${action}`)
}

const services = [
  'Floki Core',
  'Cognition',
  'Vision',
  'Hearing',
  'Speech',
  'Memory',
  'Emotion',
  'Sleep Scheduler',
  'Dream Engine',
  'Local API',
  'WebSocket Connection',
  'Minecraft Bridge',
]

for (const service of services) {
  assert.match(main, new RegExp(service.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `missing service status card: ${service}`)
}

assert.doesNotMatch(settingsPage, /FLOKI_INTEGRATION_PLACEHOLDER/)
assert.match(settingsPage, /Test Native Bridge/)
assert.match(settingsPage, /Local API URL/)
assert.match(settingsPage, /Local WebSocket URL/)
assert.match(settingsPage, /Mock Mode/)

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_FULL_INTERFACE_PRESERVATION_PASS',
  settings_sections: settingsSections.length,
  system_controls: controls.length,
  service_cards: services.length,
}, null, 2))
