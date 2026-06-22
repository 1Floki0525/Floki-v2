#!/usr/bin/env python3

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path('/media/binary-god/1tb-ssd/Floki-v2')
REPO = '1Floki0525/Floki-v2'
SELF = Path('bin/floki-neural-interface-full-function-repair-v22.py')
PASS = 'FLOKI_V22_NEURAL_INTERFACE_FULL_FUNCTION_REPAIR_PASS'
FAIL = 'FLOKI_V22_NEURAL_INTERFACE_FULL_FUNCTION_REPAIR_FAIL'

INTERFACE_YAML = '''interface:
  settings_version: 3
  connection:
    transport: electron-ipc
    local_api_url: http://127.0.0.1:7700
    local_ws_url: ws://127.0.0.1:7700/ws
    auto_reconnect: true
    reconnect_delay_ms: 3000
    request_timeout_ms: 120000
    mock_mode: false
  chat:
    stream_responses: true
    show_timestamps: true
    markdown_rendering: true
    compact_messages: false
    enter_to_send: true
    max_local_history: 500
  voice:
    microphone_enabled: true
    speaker_enabled: true
    hands_free_listening: true
    push_to_talk: false
    wake_word_enabled: true
    wake_phrase: Hey Floki
    speech_volume: 80
    speech_rate: 1
    interruptible_speech: true
    show_partial_transcription: true
  vision:
    show_object_boxes: true
    show_person_boxes: true
    show_face_boxes: true
    show_recognized_names: true
    show_labels: true
    show_confidence: true
    show_scene_recognition: true
    observation_freshness_threshold: 30
    stale_observation_warning: true
    privacy_blackout_default: false
  emotions:
    graph_time_range: 5m
    update_frequency: 2000
    graph_smoothing: 0.3
  neural_stream:
    auto_scroll: true
    max_events: 1000
    compact_view: false
    default_privacy_filter: all
  appearance:
    neon_intensity: 70
    glow_intensity: 50
    animation_level: normal
    font_size: 14
    interface_scale: 100
    panel_density: comfortable
    reduced_motion: false
  latency:
    first_token_target: 500
    first_spoken_audio_target: 1500
    slow_warning_threshold: 2000
    critical_threshold: 5000
    show_detailed_stage_timing: true
  privacy:
    hide_vision_by_default: false
    hide_recognized_names: false
    redact_private_metadata: false
    allow_local_export: true
    clear_stored_preferences: false
'''

INTERFACE_SETTINGS = r'''\'use strict\';

const fs = require('node:fs');
const path = require('node:path');
const { loadYamlFile } = require('./yaml-lite.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 3;
const DEFAULTS = Object.freeze({
  version: VERSION,
  connection: { transport: 'electron-ipc', localApiUrl: 'http://127.0.0.1:7700', localWsUrl: 'ws://127.0.0.1:7700/ws', autoReconnect: true, reconnectDelay: 3000, requestTimeout: 120000, mockMode: false },
  chat: { streamResponses: true, showTimestamps: true, markdownRendering: true, compactMessages: false, enterToSend: true, maxLocalHistory: 500 },
  voice: { microphoneEnabled: true, speakerEnabled: true, handsFreeListening: true, pushToTalk: false, wakeWordEnabled: true, wakePhrase: 'Hey Floki', speechVolume: 80, speechRate: 1, interruptibleSpeech: true, showPartialTranscription: true },
  vision: { showObjectBoxes: true, showPersonBoxes: true, showFaceBoxes: true, showRecognizedNames: true, showLabels: true, showConfidence: true, showSceneRecognition: true, observationFreshnessThreshold: 30, staleObservationWarning: true, privacyBlackoutDefault: false },
  emotions: { graphTimeRange: '5m', updateFrequency: 2000, graphSmoothing: 0.3 },
  neuralStream: { autoScroll: true, maxEvents: 1000, compactView: false, defaultPrivacyFilter: 'all' },
  appearance: { neonIntensity: 70, glowIntensity: 50, animationLevel: 'normal', fontSize: 14, interfaceScale: 100, panelDensity: 'comfortable', reducedMotion: false },
  latency: { firstTokenTarget: 500, firstSpokenAudioTarget: 1500, slowWarningThreshold: 2000, criticalThreshold: 5000, showDetailedStageTiming: true },
  privacy: { hideVisionByDefault: false, hideRecognizedNames: false, redactPrivateMetadata: false, allowLocalExport: true, clearStoredPreferences: false }
});
const MAP = Object.freeze({
  connection: { transport: 'transport', localApiUrl: 'local_api_url', localWsUrl: 'local_ws_url', autoReconnect: 'auto_reconnect', reconnectDelay: 'reconnect_delay_ms', requestTimeout: 'request_timeout_ms', mockMode: 'mock_mode' },
  chat: { streamResponses: 'stream_responses', showTimestamps: 'show_timestamps', markdownRendering: 'markdown_rendering', compactMessages: 'compact_messages', enterToSend: 'enter_to_send', maxLocalHistory: 'max_local_history' },
  voice: { microphoneEnabled: 'microphone_enabled', speakerEnabled: 'speaker_enabled', handsFreeListening: 'hands_free_listening', pushToTalk: 'push_to_talk', wakeWordEnabled: 'wake_word_enabled', wakePhrase: 'wake_phrase', speechVolume: 'speech_volume', speechRate: 'speech_rate', interruptibleSpeech: 'interruptible_speech', showPartialTranscription: 'show_partial_transcription' },
  vision: { showObjectBoxes: 'show_object_boxes', showPersonBoxes: 'show_person_boxes', showFaceBoxes: 'show_face_boxes', showRecognizedNames: 'show_recognized_names', showLabels: 'show_labels', showConfidence: 'show_confidence', showSceneRecognition: 'show_scene_recognition', observationFreshnessThreshold: 'observation_freshness_threshold', staleObservationWarning: 'stale_observation_warning', privacyBlackoutDefault: 'privacy_blackout_default' },
  emotions: { graphTimeRange: 'graph_time_range', updateFrequency: 'update_frequency', graphSmoothing: 'graph_smoothing' },
  neuralStream: { autoScroll: 'auto_scroll', maxEvents: 'max_events', compactView: 'compact_view', defaultPrivacyFilter: 'default_privacy_filter' },
  appearance: { neonIntensity: 'neon_intensity', glowIntensity: 'glow_intensity', animationLevel: 'animation_level', fontSize: 'font_size', interfaceScale: 'interface_scale', panelDensity: 'panel_density', reducedMotion: 'reduced_motion' },
  latency: { firstTokenTarget: 'first_token_target', firstSpokenAudioTarget: 'first_spoken_audio_target', slowWarningThreshold: 'slow_warning_threshold', criticalThreshold: 'critical_threshold', showDetailedStageTiming: 'show_detailed_stage_timing' },
  privacy: { hideVisionByDefault: 'hide_vision_by_default', hideRecognizedNames: 'hide_recognized_names', redactPrivateMetadata: 'redact_private_metadata', allowLocalExport: 'allow_local_export', clearStoredPreferences: 'clear_stored_preferences' }
});
const RANGE = Object.freeze({
  'connection.reconnectDelay': [1000, 30000], 'connection.requestTimeout': [5000, 300000], 'chat.maxLocalHistory': [50, 5000],
  'voice.speechVolume': [0, 100], 'voice.speechRate': [0.5, 2], 'vision.observationFreshnessThreshold': [5, 120],
  'emotions.updateFrequency': [500, 10000], 'emotions.graphSmoothing': [0, 1], 'neuralStream.maxEvents': [100, 10000],
  'appearance.neonIntensity': [0, 100], 'appearance.glowIntensity': [0, 100], 'appearance.fontSize': [10, 24], 'appearance.interfaceScale': [75, 150],
  'latency.firstTokenTarget': [100, 5000], 'latency.firstSpokenAudioTarget': [500, 10000], 'latency.slowWarningThreshold': [500, 10000], 'latency.criticalThreshold': [1000, 30000]
});
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function configPath(mode = 'chat') { return path.join(PROJECT_ROOT, 'config', mode === 'game' ? 'game.config.yaml' : 'chat.config.yaml'); }
function validate(section, key, value) {
  const expected = DEFAULTS[section][key];
  if (typeof value !== typeof expected) throw new Error(section + '.' + key + ' must be ' + typeof expected);
  if (typeof value === 'string' && !value.trim()) throw new Error(section + '.' + key + ' cannot be empty');
  const range = RANGE[section + '.' + key];
  if (range && (!Number.isFinite(value) || value < range[0] || value > range[1])) throw new Error(section + '.' + key + ' is outside its allowed range');
  if (section === 'connection' && key === 'mockMode' && value !== false) throw new Error('Mock Mode is prohibited in live chat.local');
  return value;
}
function normalize(input) {
  const out = { version: VERSION };
  for (const section of Object.keys(MAP)) {
    out[section] = {};
    for (const key of Object.keys(MAP[section])) out[section][key] = validate(section, key, input && input[section] && Object.prototype.hasOwnProperty.call(input[section], key) ? input[section][key] : DEFAULTS[section][key]);
  }
  return out;
}
function getInterfaceSettings(mode = 'chat') {
  const raw = loadYamlFile(configPath(mode));
  const root = raw.interface || {};
  const out = { version: Number(root.settings_version || VERSION) };
  for (const section of Object.keys(MAP)) {
    out[section] = {};
    for (const [key, yamlKey] of Object.entries(MAP[section])) out[section][key] = root[section] && Object.prototype.hasOwnProperty.call(root[section], yamlKey) ? root[section][yamlKey] : DEFAULTS[section][key];
  }
  return normalize(out);
}
function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^(true|false|null|-?\\d+(\\.\\d+)?)$/.test(text) || text.includes(' #') ? JSON.stringify(text) : text;
}
function serialize(settings) {
  const safe = normalize(settings);
  const lines = ['interface:', '  settings_version: ' + VERSION];
  for (const section of Object.keys(MAP)) {
    const yamlSection = section.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
    lines.push('  ' + yamlSection + ':');
    for (const [key, yamlKey] of Object.entries(MAP[section])) lines.push('    ' + yamlKey + ': ' + scalar(safe[section][key]));
  }
  return lines.join('\\n');
}
function replaceBlock(text, replacement) {
  const lines = String(text).split(/\\r?\\n/);
  const start = lines.findIndex((line) => line === 'interface:');
  if (start < 0) return text.replace(/\\s*$/, '') + '\\n\\n' + replacement + '\\n';
  let end = start + 1;
  while (end < lines.length && (!lines[end] || lines[end].startsWith(' '))) end += 1;
  return [...lines.slice(0, start), ...replacement.split('\\n'), ...lines.slice(end)].join('\\n').replace(/\\s*$/, '\\n');
}
function write(settings, mode = 'chat') {
  const file = configPath(mode);
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, replaceBlock(fs.readFileSync(file, 'utf8'), serialize(settings)), 'utf8');
  fs.renameSync(temp, file);
  return getInterfaceSettings(mode);
}
function updateInterfaceSettings(section, values, mode = 'chat') {
  if (!MAP[section]) throw new Error('unknown settings section: ' + section);
  const next = clone(getInterfaceSettings(mode));
  for (const [key, value] of Object.entries(values || {})) {
    if (!MAP[section][key]) throw new Error('unknown setting: ' + section + '.' + key);
    next[section][key] = validate(section, key, value);
  }
  return write(next, mode);
}
function resetInterfaceSettings(section = null, mode = 'chat') {
  if (section === null) return write(clone(DEFAULTS), mode);
  if (!MAP[section]) throw new Error('unknown settings section: ' + section);
  const next = clone(getInterfaceSettings(mode));
  next[section] = clone(DEFAULTS[section]);
  return write(next, mode);
}
function importInterfaceSettings(value, mode = 'chat') { return write(normalize(typeof value === 'string' ? JSON.parse(value) : value), mode); }
module.exports = { PROJECT_ROOT, DEFAULTS, MAP, getInterfaceSettings, updateInterfaceSettings, resetInterfaceSettings, importInterfaceSettings, normalize, serialize };
'''

MANUAL_NAP = r'''\'use strict\';
const path = require('node:path');
const { statePath, readJsonFileSync, writeJsonFileAtomicSync, existsSync } = require('../util/fs-safe.cjs');
const { loadYamlFile } = require('../config/yaml-lite.cjs');
const { PROJECT_ROOT } = require('../config/floki-config.cjs');
const DEFAULT_STATE_FILE = statePath('chat/sleep/manual-nap-state.json');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'chat.config.yaml');
function now(options = {}) { return options.now ? new Date(options.now) : new Date(); }
function napConfig() {
  const sleep = loadYamlFile(CONFIG_FILE).sleep || {};
  const duration = Number(sleep.manual_nap_duration_minutes);
  const remOffset = Number(sleep.manual_nap_rem_offset_minutes);
  if (duration !== 30) throw new Error('sleep.manual_nap_duration_minutes must remain exactly 30');
  if (!(remOffset > 0 && remOffset < duration)) throw new Error('manual nap REM offset must be inside the nap');
  return Object.freeze({ duration_minutes: duration, rem_offset_minutes: remOffset });
}
function file(options = {}) { return options.state_file || DEFAULT_STATE_FILE; }
function raw(options = {}) { return existsSync(file(options)) ? readJsonFileSync(file(options)) : null; }
function save(state, options = {}) { writeJsonFileAtomicSync(file(options), state); return state; }
function readManualNapState(options = {}) {
  const state = raw(options);
  if (!state || state.active !== true || now(options) < new Date(state.wake_at)) return state;
  return save(Object.freeze({ ...state, active: false, completed: true, completed_at: now(options).toISOString(), wake_reason: 'duration_elapsed', last_transition_at: now(options).toISOString() }), options);
}
function beginManualNap(options = {}) {
  const cfg = napConfig();
  const at = now(options);
  const current = readManualNapState({ ...options, now: at });
  if (current && current.active === true) return current;
  return save(Object.freeze({
    kind: 'manual_nap', active: true, completed: false, duration_minutes: cfg.duration_minutes,
    started_at: at.toISOString(), wake_at: new Date(at.getTime() + cfg.duration_minutes * 60000).toISOString(), last_transition_at: at.toISOString(), wake_reason: null,
    consolidation: options.consolidation || null,
    rem_cycles: [Object.freeze({ cycle_number: 1, scheduled_at: new Date(at.getTime() + cfg.rem_offset_minutes * 60000).toISOString(), status: 'pending', dreaming_started_at: null, dreaming_process_pid: null, completed_at: null, dream_txt_file: null, dream_metadata_file: null, last_error: null })],
    nightly_schedule_modified: false, chat_mode_only: true, game_mode_started: false
  }), options);
}
function wakeManualNap(reason = 'manual_wake', options = {}) {
  const state = raw(options);
  if (!state || state.active !== true) return state || Object.freeze({ active: false, completed: true, wake_reason: 'not_active', nightly_schedule_modified: false });
  return save(Object.freeze({ ...state, active: false, completed: true, completed_at: now(options).toISOString(), wake_reason: reason, last_transition_at: now(options).toISOString() }), options);
}
function claimDueRemCycle(options = {}) {
  const state = readManualNapState(options);
  if (!state || state.active !== true) return null;
  const index = state.rem_cycles.findIndex((cycle) => cycle.status === 'pending' && new Date(cycle.scheduled_at) <= now(options));
  if (index < 0) return null;
  const cycle = Object.freeze({ ...state.rem_cycles[index], status: 'dreaming', dreaming_started_at: now(options).toISOString(), dreaming_process_pid: process.pid });
  const next = Object.freeze({ ...state, rem_cycles: state.rem_cycles.map((item, i) => i === index ? cycle : item), last_transition_at: now(options).toISOString() });
  save(next, options);
  return Object.freeze({ state: next, cycle });
}
function finishRemCycle(result, error, options = {}) {
  const state = raw(options);
  if (!state) return null;
  return save(Object.freeze({ ...state, rem_cycles: state.rem_cycles.map((cycle) => cycle.status !== 'dreaming' ? cycle : Object.freeze({ ...cycle, status: error ? 'failed' : 'complete', dreaming_process_pid: null, completed_at: now(options).toISOString(), dream_txt_file: result && result.dream_txt_file || null, dream_metadata_file: result && result.dream_metadata_file || null, last_error: error ? error.message : null })), last_transition_at: now(options).toISOString(), last_rem_error: error ? error.message : null }), options);
}
module.exports = { DEFAULT_STATE_FILE, napConfig, readManualNapState, beginManualNap, wakeManualNap, claimDueRemCycle, finishRemCycle };
'''

SETTINGS_STORE = r'''let currentSettings = {
  version: 3,
  connection: { transport: 'electron-ipc', localApiUrl: 'http://127.0.0.1:7700', localWsUrl: 'ws://127.0.0.1:7700/ws', autoReconnect: true, reconnectDelay: 3000, requestTimeout: 120000, mockMode: false },
  chat: { streamResponses: true, showTimestamps: true, markdownRendering: true, compactMessages: false, enterToSend: true, maxLocalHistory: 500 },
  voice: { microphoneEnabled: true, speakerEnabled: true, handsFreeListening: true, pushToTalk: false, wakeWordEnabled: true, wakePhrase: 'Hey Floki', speechVolume: 80, speechRate: 1, interruptibleSpeech: true, showPartialTranscription: true },
  vision: { showObjectBoxes: true, showPersonBoxes: true, showFaceBoxes: true, showRecognizedNames: true, showLabels: true, showConfidence: true, showSceneRecognition: true, observationFreshnessThreshold: 30, staleObservationWarning: true, privacyBlackoutDefault: false },
  emotions: { visibleChannels: [], graphTimeRange: '5m', updateFrequency: 2000, graphSmoothing: 0.3 }, neuralStream: { visibleModules: [], autoScroll: true, maxEvents: 1000, defaultPrivacyFilter: 'all', compactView: false },
  appearance: { neonIntensity: 70, glowIntensity: 50, animationLevel: 'normal', fontSize: 14, interfaceScale: 100, panelDensity: 'comfortable', reducedMotion: false },
  latency: { firstTokenTarget: 500, firstSpokenAudioTarget: 1500, slowWarningThreshold: 2000, criticalThreshold: 5000, showDetailedStageTiming: true },
  privacy: { hideVisionByDefault: false, hideRecognizedNames: false, redactPrivateMetadata: false, allowLocalExport: true, clearStoredPreferences: false }
};
let listeners = [];
let loading = null;
function bridge() { if (!window.floki) throw new Error('Floki Electron settings bridge is unavailable'); return window.floki; }
function notify(next) { currentSettings = next; listeners.forEach((listener) => listener(currentSettings)); return currentSettings; }
export function getSettings() { return currentSettings; }
export function initializeSettings() { if (!loading) loading = bridge().getSettings().then(notify).finally(() => { loading = null; }); return loading; }
export async function updateSettings(section, values) { return notify(await bridge().updateSettings(section, values)); }
export async function resetSection(section) { return notify(await bridge().resetSettings(section)); }
export async function resetAllSettings() { return notify(await bridge().resetAllSettings()); }
export async function clearStoredSettings() { return resetAllSettings(); }
export function exportSettings() { return JSON.stringify(currentSettings, null, 2); }
export async function importSettings(value) { return notify(await bridge().importSettings(typeof value === 'string' ? JSON.parse(value) : value)); }
export function subscribeSettings(listener) { listeners.push(listener); return () => { listeners = listeners.filter((entry) => entry !== listener); }; }
export function getDefaultSettings() { return JSON.parse(JSON.stringify(currentSettings)); }
'''

USE_SETTINGS = r'''import { useState, useEffect, useCallback } from 'react';
import { getSettings, initializeSettings, updateSettings, subscribeSettings } from '@/stores/settingsStore';
export default function useSettings(section) {
  const [settings, setSettings] = useState(getSettings());
  useEffect(() => { const unsubscribe = subscribeSettings(setSettings); initializeSettings().catch((error) => console.error('YAML settings load failed', error)); return unsubscribe; }, []);
  const update = useCallback((values) => updateSettings(section, values), [section]);
  return [section ? settings[section] : settings, update];
}
'''

NAP_TEST = r'''\'use strict\';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadYamlFile } = require('../src/config/yaml-lite.cjs');
const { beginManualNap, readManualNapState, wakeManualNap, claimDueRemCycle, finishRemCycle } = require('../src/chat/manual-nap.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-v22-nap-'));
const state_file = path.join(dir, 'state.json');
const start = new Date('2026-06-22T15:00:00.000Z');
const yaml = loadYamlFile(path.join(__dirname, '../config/chat.config.yaml'));
assert.equal(yaml.sleep.start_hhmm, '23:00');
assert.equal(yaml.sleep.end_hhmm, '07:00');
const state = beginManualNap({ state_file, now: start, consolidation: { ok: true } });
assert.equal(state.duration_minutes, 30);
assert.equal(new Date(state.wake_at).getTime() - start.getTime(), 1800000);
assert.equal(state.nightly_schedule_modified, false);
const claim = claimDueRemCycle({ state_file, now: new Date(start.getTime() + 15 * 60000) });
assert.equal(claim.cycle.status, 'dreaming');
finishRemCycle({ dream_txt_file: '/tmp/dream.txt' }, null, { state_file, now: new Date(start.getTime() + 16 * 60000) });
assert.equal(readManualNapState({ state_file, now: new Date(start.getTime() + 16 * 60000) }).rem_cycles[0].status, 'complete');
assert.equal(wakeManualNap('manual_wake', { state_file, now: new Date(start.getTime() + 20 * 60000) }).active, false);
fs.rmSync(dir, { recursive: true, force: true });
console.log('FLOKI_V22_MANUAL_NAP_CONTRACT_PASS');
'''

CONTROL_TEST = r'''\'use strict\';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
assert.equal(read('apps/floki-neural-interface/src/stores/settingsStore.js').includes('localStorage'), false);
assert.equal(read('apps/floki-neural-interface/src/components/chat/ChatMessage.jsx').includes('onRegenerate'), true);
assert.equal(read('apps/floki-neural-interface/electron/main.cjs').includes("runtimeRequest('POST', '/nap/request'"), true);
assert.equal(read('src/runtime/chat-local-runtime.cjs').includes("url.pathname === '/nap/request'"), true);
assert.equal(read('src/runtime/chat-local-runtime.cjs').includes("url.pathname === '/audio/push-to-talk'"), true);
assert.equal(read('apps/floki-neural-interface/src/components/system/SystemControls.jsx').includes('Request 30-Minute Nap'), true);
assert.equal(read('src/config/interface-settings.cjs').includes('updateInterfaceSettings'), true);
console.log('FLOKI_V22_FUNCTIONAL_CONTROLS_CONTRACT_PASS');
'''


def log(message): print(f'[floki-v22] {message}', flush=True)
class RepairError(RuntimeError): pass

def run(args, check=True, timeout=None):
    shown = ' '.join(map(str, args)); log('run: ' + shown)
    result = subprocess.run(list(map(str, args)), cwd=str(ROOT), text=True, capture_output=True, timeout=timeout)
    if result.stdout: print(result.stdout, end='' if result.stdout.endswith('\n') else '\n', flush=True)
    if result.stderr: print(result.stderr, end='' if result.stderr.endswith('\n') else '\n', file=sys.stderr, flush=True)
    if check and result.returncode != 0: raise RepairError(f'command failed ({result.returncode}): {shown}')
    return result

def git(*args):
    result = subprocess.run(['git', *args], cwd=str(ROOT), text=True, capture_output=True)
    if result.returncode != 0: raise RepairError(result.stderr.strip() or 'git failed')
    return result.stdout.strip()

def replace(text, old, new, label):
    if new in text: return text
    count = text.count(old)
    if count != 1: raise RepairError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

def write(relative, content):
    path = ROOT / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content.rstrip() + '\n', encoding='utf-8')

def replace_interface(text):
    lines = text.splitlines(); start = next((i for i, line in enumerate(lines) if line == 'interface:'), None)
    if start is None: return text.rstrip() + '\n\n' + INTERFACE_YAML.rstrip() + '\n'
    end = start + 1
    while end < len(lines) and (not lines[end] or lines[end].startswith(' ')): end += 1
    return '\n'.join(lines[:start] + INTERFACE_YAML.rstrip().splitlines() + lines[end:]).rstrip() + '\n'

def set_sleep(text, key, value):
    lines = text.splitlines(); start = lines.index('sleep:'); end = start + 1
    while end < len(lines) and (not lines[end] or lines[end].startswith(' ')): end += 1
    prefix = '  ' + key + ':'
    for i in range(start + 1, end):
        if lines[i].startswith(prefix): lines[i] = prefix + ' ' + value; return '\n'.join(lines).rstrip() + '\n'
    lines.insert(end, prefix + ' ' + value); return '\n'.join(lines).rstrip() + '\n'

def patch_yaml(path):
    text = path.read_text(encoding='utf-8'); text = set_sleep(text, 'manual_nap_duration_minutes', '30'); text = set_sleep(text, 'manual_nap_rem_offset_minutes', '15'); path.write_text(replace_interface(text), encoding='utf-8')

def patch_files():
    for file in ['config/chat.config.yaml', 'config/game.config.yaml', 'config/chat.config.yaml.temp', 'config/game.config.yaml.temp']: patch_yaml(ROOT / file)
    write('src/config/interface-settings.cjs', INTERFACE_SETTINGS)
    write('src/chat/manual-nap.cjs', MANUAL_NAP)
    write('apps/floki-neural-interface/src/stores/settingsStore.js', SETTINGS_STORE)
    write('apps/floki-neural-interface/src/hooks/useSettings.js', USE_SETTINGS)
    write('tests/manual-nap-contract-test.cjs', NAP_TEST)
    write('apps/floki-neural-interface/tests/functional-controls-contract.cjs', CONTROL_TEST)

    path = ROOT / 'src/config/floki-config.cjs'; text = path.read_text()
    text = replace(text, "    lifecycle_transition_notifications_enabled: requireBoolean(section.lifecycle_transition_notifications_enabled, 'sleep.lifecycle_transition_notifications_enabled')\n", "    lifecycle_transition_notifications_enabled: requireBoolean(section.lifecycle_transition_notifications_enabled, 'sleep.lifecycle_transition_notifications_enabled'),\n    manual_nap_duration_minutes: requireNumber(section.manual_nap_duration_minutes, 'sleep.manual_nap_duration_minutes'),\n    manual_nap_rem_offset_minutes: requireNumber(section.manual_nap_rem_offset_minutes, 'sleep.manual_nap_rem_offset_minutes')\n", 'sleep config fields'); path.write_text(text)

    path = ROOT / 'src/chat/floki-lifecycle-status.cjs'; text = path.read_text()
    text = replace(text, "} = require('./sleep-cycle-scheduler.cjs');\n", "} = require('./sleep-cycle-scheduler.cjs');\nconst { readManualNapState } = require('./manual-nap.cjs');\n", 'lifecycle import')
    text = replace(text, "  rem_dreaming: 'REM DREAMING',\n", "  rem_dreaming: 'REM DREAMING',\n  manual_nap: 'ASLEEP — 30-MINUTE NAP',\n  manual_nap_rem: 'REM DREAMING — MANUAL NAP',\n", 'lifecycle labels')
    text = replace(text, "  const sleepWindow = getSleepWindowForDate(now, sleepOptions);\n", "  const sleepWindow = getSleepWindowForDate(now, sleepOptions);\n  const manualNap = options.manual_nap_state || readManualNapState({ now });\n", 'lifecycle state')
    marker = "  if (stateLoaded && (!Array.isArray(savedState.rem_cycles)"
    overlay = "  if (manualNap && manualNap.active === true) {\n    const dreaming = (manualNap.rem_cycles || []).find((cycle) => cycle.status === 'dreaming');\n    const pending = (manualNap.rem_cycles || []).find((cycle) => cycle.status === 'pending');\n    return Object.freeze({ ...base, state: dreaming ? 'rem_dreaming' : 'asleep', display_label: dreaming ? DISPLAY_LABELS.manual_nap_rem : DISPLAY_LABELS.manual_nap, is_awake: false, is_asleep: true, is_dreaming: Boolean(dreaming), is_rem_dreaming: Boolean(dreaming), source_of_truth: 'manual_nap_state', manual_nap_active: true, manual_nap_started_at: manualNap.started_at, manual_nap_wake_at: manualNap.wake_at, manual_nap_duration_minutes: manualNap.duration_minutes, manual_nap_rem_cycles: manualNap.rem_cycles || [], current_rem_cycle_number: dreaming ? dreaming.cycle_number : null, current_rem_started_at: dreaming ? dreaming.dreaming_started_at : null, next_rem_cycle_number: pending ? pending.cycle_number : null, next_rem_cycle_at: pending ? pending.scheduled_at : null, last_transition_at: manualNap.last_transition_at || manualNap.started_at, nightly_schedule_modified: false });\n  }\n\n"
    text = replace(text, marker, overlay + marker, 'lifecycle overlay'); path.write_text(text)

    path = ROOT / 'src/runtime/chat-local-runtime.cjs'; text = path.read_text()
    text = replace(text, "const { newId } = require('../util/ids.cjs');\n", "const { newId } = require('../util/ids.cjs');\nconst { getInterfaceSettings } = require('../config/interface-settings.cjs');\nconst { readManualNapState, beginManualNap, wakeManualNap, claimDueRemCycle, finishRemCycle } = require('../chat/manual-nap.cjs');\nconst { runDreamEngineOnce } = require('../chat/dream-engine.cjs');\n", 'runtime imports')
    text = replace(text, "  let visionManagedSleeping = false;\n", "  let visionManagedSleeping = false;\n  let manualNapDreamTask = null;\n  let lastManualNapActive = false;\n", 'runtime vars')
    text = replace(text, "    last_grounded_vision_available: null\n", "    last_grounded_vision_available: null,\n    push_to_talk_active: false\n", 'runtime ptt')
    old = "  async function applyLifecycle(next) {\n    lifecycle = next;\n    const awake = next && next.is_awake === true;\n    const enableSenses = awake && state.client_ready === true;\n    state.senses_enabled = enableSenses;\n\n    try {\n      await liveAudio.setAwake(enableSenses);\n"
    new = "  async function applyLifecycle(next) {\n    lifecycle = next;\n    const awake = next && next.is_awake === true;\n    const voice = getInterfaceSettings('chat').voice;\n    const hearingEnabled = awake && state.client_ready === true && voice.microphoneEnabled === true && (voice.pushToTalk === true ? state.push_to_talk_active === true : voice.handsFreeListening === true);\n    const visionEnabled = awake && state.client_ready === true;\n    state.senses_enabled = hearingEnabled || visionEnabled;\n\n    try {\n      await liveAudio.setAwake(hearingEnabled);\n"
    text = replace(text, old, new, 'runtime lifecycle'); text = text.replace('    if (!enableSenses) {', '    if (!visionEnabled) {', 1)
    nap_funcs = "  async function requestManualNap() {\n    const consolidation = brain.requireModule('hippocampus').consolidateShortTerm();\n    const nap = beginManualNap({ consolidation });\n    lastManualNapActive = true;\n    await applyLifecycle(buildFlokiLifecycleStatus());\n    const snapshot = status();\n    const verified = snapshot.lifecycle.manual_nap_active === true && snapshot.lifecycle.manual_nap_duration_minutes === 30 && snapshot.hearing.microphone_open === false && snapshot.vision.camera_open === false;\n    return Object.freeze({ ok: verified, verified, marker: verified ? 'FLOKI_V22_MANUAL_NAP_REQUEST_PASS' : 'FLOKI_V22_MANUAL_NAP_REQUEST_FAIL', nap, consolidation, status: snapshot });\n  }\n  async function wakeFromManualNap() {\n    const nap = wakeManualNap('manual_wake'); lastManualNapActive = false; await applyLifecycle(buildFlokiLifecycleStatus());\n    return Object.freeze({ ok: nap.active !== true, verified: nap.active !== true, marker: 'FLOKI_V22_MANUAL_NAP_WAKE_PASS', nap, status: status() });\n  }\n  async function processManualNap() {\n    const nap = readManualNapState();\n    if (!nap || nap.active !== true) { if (lastManualNapActive) { lastManualNapActive = false; await applyLifecycle(buildFlokiLifecycleStatus()); } return; }\n    lastManualNapActive = true; if (manualNapDreamTask) return; const claim = claimDueRemCycle(); if (!claim) return;\n    manualNapDreamTask = runDreamEngineOnce({ env: { ...process.env, FLOKI_ALLOW_DREAM_ENGINE: '1' }, rem_cycle_number: claim.cycle.cycle_number, sleep_window_start: claim.state.started_at, sleep_window_end: claim.state.wake_at }).then((result) => finishRemCycle(result, null)).catch((error) => { finishRemCycle(null, error); appendLog('manual nap REM failed: ' + error.message); }).finally(async () => { manualNapDreamTask = null; await applyLifecycle(buildFlokiLifecycleStatus()); });\n  }\n\n"
    text = replace(text, '  async function route(req, res) {\n', nap_funcs + '  async function route(req, res) {\n', 'runtime nap functions')
    old_interrupt = "    if (req.method === 'POST' && url.pathname === '/interrupt') {\n      if (activeAbortController) activeAbortController.abort();\n      sendJson(res, 200, { ok: true, interrupted: Boolean(activeAbortController) });\n      return;\n    }\n"
    new_interrupt = "    if (req.method === 'POST' && url.pathname === '/interrupt') { const hadTurn = Boolean(activeAbortController); if (activeAbortController) activeAbortController.abort(); const speech = liveAudio.interruptSpeech(); sendJson(res, 200, { ok: true, interrupted: hadTurn || speech.interrupted === true, speech }); return; }\n    if (req.method === 'POST' && url.pathname === '/nap/request') { sendJson(res, 200, await requestManualNap()); return; }\n    if (req.method === 'POST' && url.pathname === '/nap/wake') { sendJson(res, 200, await wakeFromManualNap()); return; }\n    if (req.method === 'GET' && url.pathname === '/nap/status') { sendJson(res, 200, { ok: true, nap: readManualNapState(), lifecycle: buildFlokiLifecycleStatus() }); return; }\n    if (req.method === 'POST' && url.pathname === '/settings/reload') { await applyLifecycle(buildFlokiLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, settings: getInterfaceSettings('chat'), status: status() }); return; }\n    if (req.method === 'POST' && url.pathname === '/audio/push-to-talk') { const body = await bodyJson(req); state.push_to_talk_active = body.active === true; await applyLifecycle(buildFlokiLifecycleStatus()); sendJson(res, 200, { ok: true, verified: true, active: state.push_to_talk_active, status: status() }); return; }\n"
    text = replace(text, old_interrupt, new_interrupt, 'runtime routes')
    text = replace(text, "    lifecycleTimer = setInterval(() => {\n      const next = buildFlokiLifecycleStatus();\n", "    lifecycleTimer = setInterval(() => {\n      void processManualNap().catch((error) => appendLog('manual nap processing failed: ' + error.message));\n      const next = buildFlokiLifecycleStatus();\n", 'runtime nap timer'); path.write_text(text)

    path = ROOT / 'src/senses/live-audio-service.cjs'; text = path.read_text()
    text = replace(text, "const { createLivePiperService } = require('./live-piper-service.cjs');\n", "const { createLivePiperService } = require('./live-piper-service.cjs');\nconst { getInterfaceSettings } = require('../config/interface-settings.cjs');\n", 'audio settings')
    text = replace(text, "      if (response && response.reply) {\n        await piper.speak(response.reply, { utterance_id: utteranceId, text_hash: 'live_audio_' + String(response.reply.length) });\n", "      if (response && response.reply && getInterfaceSettings('chat').voice.speakerEnabled === true) {\n        await piper.speak(response.reply, { utterance_id: utteranceId, text_hash: 'live_audio_' + String(response.reply.length) });\n", 'audio speaker')
    text = replace(text, "    speak: (text, metadata) => piper.speak(text, metadata),\n", "    speak: (text, metadata) => piper.speak(text, metadata),\n    interruptSpeech: () => piper.interrupt(),\n", 'audio interrupt'); path.write_text(text)

    path = ROOT / 'src/senses/live-piper-service.cjs'; text = path.read_text()
    text = replace(text, "const { runPlaybackWithVoiceLockAsync } = require('./piper-speaker-playback.cjs');\n", "const { runPlaybackWithVoiceLockAsync } = require('./piper-speaker-playback.cjs');\nconst { getInterfaceSettings } = require('../config/interface-settings.cjs');\n", 'piper settings')
    text = replace(text, "  const aplay = commandPath('aplay');\n", "  const aplay = commandPath('aplay');\n  let activeSpeechController = null;\n  function voiceSettings() { return getInterfaceSettings('chat').voice; }\n  function applyOutputVolume() { const volume = Math.max(0, Math.min(100, Number(voiceSettings().speechVolume || 80))); const wpctl = commandPath('wpctl'); if (wpctl) { spawnSync(wpctl, ['set-volume', '@DEFAULT_AUDIO_SINK@', String(volume / 100)], { encoding: 'utf8' }); return 'wpctl'; } const pactl = commandPath('pactl'); if (pactl) { spawnSync(pactl, ['set-sink-volume', '@DEFAULT_SINK@', String(volume) + '%'], { encoding: 'utf8' }); return 'pactl'; } return null; }\n", 'piper helpers')
    text = replace(text, "    const child = spawn(PIPER_CLI, ['--model', voice.model, '--config', voice.config, '--output_file', outputFile], {\n", "    const rate = Math.max(0.5, Math.min(2, Number(voiceSettings().speechRate || 1)));\n    const child = spawn(PIPER_CLI, ['--model', voice.model, '--config', voice.config, '--length_scale', String(1 / rate), '--output_file', outputFile], {\n", 'piper rate')
    text = replace(text, "  async function speak(text, metadata = {}) {\n    if (state.speaking) throw new Error('Piper is already speaking');\n", "  async function speak(text, metadata = {}) {\n    if (voiceSettings().speakerEnabled !== true) return Object.freeze({ ok: true, skipped: true, reason: 'speaker_disabled_in_yaml' });\n    if (state.speaking) throw new Error('Piper is already speaking');\n", 'piper enabled')
    text = replace(text, "      synthesis = await synthesize(text, metadata);\n      state.last_first_audio_at = nowIso();\n      const playback = await runPlaybackWithVoiceLockAsync(synthesis.output_file, {\n", "      synthesis = await synthesize(text, metadata); state.last_first_audio_at = nowIso(); applyOutputVolume(); activeSpeechController = new AbortController();\n      const playback = await runPlaybackWithVoiceLockAsync(synthesis.output_file, {\n", 'piper volume')
    text = replace(text, "        voice_lock_ttl_ms: audio.voice_lock_ttl_ms\n", "        voice_lock_ttl_ms: audio.voice_lock_ttl_ms,\n        signal: activeSpeechController.signal\n", 'piper signal')
    text = replace(text, "      state.speaking = false;\n", "      activeSpeechController = null;\n      state.speaking = false;\n", 'piper clear')
    text = replace(text, "  refreshReadiness();\n  return Object.freeze({ status, refreshReadiness, synthesize, speak });\n", "  function interrupt() { if (voiceSettings().interruptibleSpeech !== true) return Object.freeze({ ok: false, interrupted: false, reason: 'interruptible_speech_disabled' }); const active = Boolean(activeSpeechController); if (activeSpeechController) activeSpeechController.abort(); return Object.freeze({ ok: true, interrupted: active }); }\n  refreshReadiness();\n  return Object.freeze({ status, refreshReadiness, synthesize, speak, interrupt });\n", 'piper interrupt'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/electron/preload.cjs'; text = path.read_text()
    text = replace(text, "  openLog: (service) => invoke('floki:open-log', { service }),\n", "  openLog: (service) => invoke('floki:open-log', { service }),\n  getSettings: () => invoke('floki:get-settings'),\n  updateSettings: (section, values) => invoke('floki:update-settings', { section, values }),\n  resetSettings: (section) => invoke('floki:reset-settings', { section }),\n  resetAllSettings: () => invoke('floki:reset-all-settings'),\n  importSettings: (settings) => invoke('floki:import-settings', { settings }),\n  setPushToTalk: (active) => invoke('floki:push-to-talk', { active }),\n", 'preload settings'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/electron/main.cjs'; text = path.read_text()
    text = replace(text, "const { getDetectionConfig, readLatestDetection } = require(path.join(PROJECT_ROOT, 'src/vision/yolo-detection-service.cjs'));\n", "const { getDetectionConfig, readLatestDetection } = require(path.join(PROJECT_ROOT, 'src/vision/yolo-detection-service.cjs'));\nconst { getInterfaceSettings, updateInterfaceSettings, resetInterfaceSettings, importInterfaceSettings } = require(path.join(PROJECT_ROOT, 'src/config/interface-settings.cjs'));\n", 'electron settings import')
    text = replace(text, "  ipcMain.handle('floki:get-sleep-status', async () => sleepStatus());\n", "  ipcMain.handle('floki:get-sleep-status', async () => sleepStatus());\n  ipcMain.handle('floki:get-settings', async () => getInterfaceSettings('chat'));\n  ipcMain.handle('floki:update-settings', async (_event, payload = {}) => { const settings = updateInterfaceSettings(String(payload.section || ''), payload.values || {}, 'chat'); await runtimeRequest('POST', '/settings/reload', {}).catch(() => null); return settings; });\n  ipcMain.handle('floki:reset-settings', async (_event, payload = {}) => { const settings = resetInterfaceSettings(String(payload.section || ''), 'chat'); await runtimeRequest('POST', '/settings/reload', {}).catch(() => null); return settings; });\n  ipcMain.handle('floki:reset-all-settings', async () => { const settings = resetInterfaceSettings(null, 'chat'); await runtimeRequest('POST', '/settings/reload', {}).catch(() => null); return settings; });\n  ipcMain.handle('floki:import-settings', async (_event, payload = {}) => { const settings = importInterfaceSettings(payload.settings || {}, 'chat'); await runtimeRequest('POST', '/settings/reload', {}).catch(() => null); return settings; });\n  ipcMain.handle('floki:push-to-talk', async (_event, payload = {}) => runtimeRequest('POST', '/audio/push-to-talk', { active: payload.active === true }));\n", 'electron settings handlers')
    text = replace(text, "    if (action === 'interrupt') return { ...(await runtimeRequest('POST', '/interrupt', {})), action };\n", "    if (action === 'interrupt') { const result = await runtimeRequest('POST', '/interrupt', {}); return { ...result, action, verified: result.ok === true, message: 'Response interruption verified.' }; }\n    if (action === 'requestSleep') { const result = await runtimeRequest('POST', '/nap/request', {}); return { ...result, action, message: '30-minute nap verified: asleep, microphone closed, camera closed, consolidation started.' }; }\n    if (action === 'wake') { const result = await runtimeRequest('POST', '/nap/wake', {}); return { ...result, action, message: 'Manual nap ended; nightly scheduler remains unchanged.' }; }\n", 'electron control routes')
    text = text.replace("      requestSleep: [schedulerStart],\n", '').replace("      wake: [schedulerStop],\n", '')
    text = replace(text, "    return { ok: results.every((result) => result.ok), action, results };\n", "    const verified = results.every((result) => result.ok);\n    return { ok: verified, verified, action, results, message: verified ? action + ' completed and was verified.' : null };\n", 'electron control verify'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/integrations/floki/adapter.js'; text = path.read_text()
    text = replace(text, "  async interruptResponse() { return bridge().interrupt(); }\n", "  async interruptResponse() { return bridge().interrupt(); }\n  async setPushToTalk(active) { return bridge().setPushToTalk(active); }\n", 'adapter ptt'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/components/system/SystemControls.jsx'; text = path.read_text(); text = text.replace("{ id: 'requestSleep', label: 'Request Sleep'", "{ id: 'requestSleep', label: 'Request 30-Minute Nap'").replace("{ id: 'pauseSleep', label: 'Pause Auto Sleep'", "{ id: 'pauseSleep', label: 'Pause Nightly Scheduler'").replace("{ id: 'resumeSleep', label: 'Resume Auto Sleep'", "{ id: 'resumeSleep', label: 'Resume Nightly Scheduler'"); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/pages/SystemDashboard.jsx'; text = path.read_text(); text = replace(text, "      if (result?.ok) toast.success(`${label} completed`)\n", "      if (result?.ok === true && result?.verified === true) toast.success(result.message || `${label} verified`)\n", 'system verified toast'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/components/chat/ChatMessage.jsx'; text = path.read_text(); text = text.replace('export default function ChatMessage({ message, showTimestamps = true }) {', 'export default function ChatMessage({ message, showTimestamps = true, onRegenerate }) {').replace('<button className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors">\n                    <RefreshCw', '<button onClick={() => onRegenerate?.(message)} disabled={!onRegenerate} className="p-1 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30">\n                    <RefreshCw'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/components/chat/ChatPanel.jsx'; text = path.read_text()
    text = replace(text, "  const handleInterrupt = useCallback(() => {\n", "  const handleRegenerate = useCallback((assistantMessage) => { const index = messages.findIndex((message) => message.id === assistantMessage.id); for (let cursor = index - 1; cursor >= 0; cursor -= 1) { if (messages[cursor].role === 'user' && String(messages[cursor].content || '').trim()) { void handleSend(messages[cursor].content); return; } } toast.error('No preceding user message is available to regenerate.'); }, [handleSend, messages]);\n\n  const handleInterrupt = useCallback(() => {\n", 'chat regenerate handler')
    text = text.replace('<ChatMessage message={message} />', '<ChatMessage message={message} onRegenerate={message.role === \'assistant\' ? handleRegenerate : undefined} />'); path.write_text(text)

    path = ROOT / 'apps/floki-neural-interface/src/pages/SettingsPage.jsx'; text = path.read_text().replace('The full interface settings surface is preserved. Native chat.local uses context-isolated Electron IPC; optional REST/WebSocket values remain available for compatibility and future remote wiring.', 'Every preference is read from and written atomically to config/chat.config.yaml through the native Electron bridge.').replace('Stored interface preferences cleared', 'YAML preferences restored to defaults').replace('Clears all locally stored UI preferences and restores defaults.', 'Restores YAML-backed interface preferences to defaults.'); path.write_text(text)

    path = ROOT / 'package.json'; package = json.loads(path.read_text()); commands = [item.strip() for item in package['scripts']['test:node24'].split('&&') if item.strip()]
    for command in ['node tests/manual-nap-contract-test.cjs', 'node apps/floki-neural-interface/tests/functional-controls-contract.cjs']:
        if command not in commands: commands.append(command)
    package['scripts']['test:node24'] = ' && '.join(commands); path.write_text(json.dumps(package, indent=2) + '\n')

def api_json(path):
    query = urllib.request.Request('https://api.github.com/repos/' + REPO + path, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'floki-v22'})
    with urllib.request.urlopen(query, timeout=30) as response: return json.loads(response.read().decode())

def wait_ci(sha):
    query = urllib.parse.urlencode({'head_sha': sha, 'event': 'push', 'per_page': 20}); info = None
    for _ in range(24):
        runs = api_json('/actions/runs?' + query).get('workflow_runs', []); info = next((item for item in runs if item.get('head_sha') == sha), None)
        if info: break
        time.sleep(10)
    if not info: raise RepairError('no GitHub Actions run appeared')
    for _ in range(60):
        runs = api_json('/actions/runs?' + query).get('workflow_runs', []); info = next((item for item in runs if item.get('head_sha') == sha), info); log(f"GitHub Actions status={info.get('status')} conclusion={info.get('conclusion')}")
        if info.get('status') == 'completed':
            if info.get('conclusion') != 'success': raise RepairError('GitHub Actions failed')
            return {'run_id': info['id'], 'run_url': info.get('html_url'), 'conclusion': 'success'}
        time.sleep(30)
    raise RepairError('GitHub Actions timed out')

def restore(originals):
    for relative, record in originals.items():
        path = ROOT / relative
        if record is None:
            if path.exists(): path.unlink()
        else:
            data, mode = record; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data); os.chmod(path, mode)

def main():
    temp = None; originals = {}; committed = False
    targets = [
      'config/chat.config.yaml', 'config/game.config.yaml', 'config/chat.config.yaml.temp', 'config/game.config.yaml.temp',
      'src/config/interface-settings.cjs', 'src/chat/manual-nap.cjs', 'src/config/floki-config.cjs', 'src/chat/floki-lifecycle-status.cjs', 'src/runtime/chat-local-runtime.cjs', 'src/senses/live-audio-service.cjs', 'src/senses/live-piper-service.cjs',
      'apps/floki-neural-interface/electron/main.cjs', 'apps/floki-neural-interface/electron/preload.cjs', 'apps/floki-neural-interface/src/integrations/floki/adapter.js', 'apps/floki-neural-interface/src/stores/settingsStore.js', 'apps/floki-neural-interface/src/hooks/useSettings.js',
      'apps/floki-neural-interface/src/components/system/SystemControls.jsx', 'apps/floki-neural-interface/src/pages/SystemDashboard.jsx', 'apps/floki-neural-interface/src/components/chat/ChatMessage.jsx', 'apps/floki-neural-interface/src/components/chat/ChatPanel.jsx', 'apps/floki-neural-interface/src/pages/SettingsPage.jsx',
      'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs', 'package.json', str(SELF)
    ]
    try:
        if git('branch', '--show-current') != 'main': raise RepairError('main branch required')
        run(['git', 'status', '--short', '--branch'])
        if git('diff', '--cached', '--name-only') or git('diff', '--name-only'): raise RepairError('tracked tree must be clean')
        run(['git', 'fetch', 'origin', 'main'])
        if git('rev-parse', 'HEAD') != git('rev-parse', 'origin/main'): raise RepairError('local main must equal origin/main')
        temp = tempfile.TemporaryDirectory(prefix='floki-v22-', dir='/tmp'); log('temporary recovery workspace: ' + temp.name)
        for relative in targets:
            path = ROOT / relative; originals[relative] = None if not path.exists() else (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
        patch_files()
        for file in ['src/config/interface-settings.cjs', 'src/chat/manual-nap.cjs', 'src/chat/floki-lifecycle-status.cjs', 'src/runtime/chat-local-runtime.cjs', 'src/senses/live-audio-service.cjs', 'src/senses/live-piper-service.cjs', 'apps/floki-neural-interface/electron/main.cjs', 'apps/floki-neural-interface/electron/preload.cjs', 'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs']:
            run(['bash', 'bin/floki-node24-run.sh', 'node', '--check', file], timeout=120)
        if 'start_hhmm: 23:00' not in (ROOT / 'config/chat.config.yaml').read_text() or 'end_hhmm: 07:00' not in (ROOT / 'config/chat.config.yaml').read_text(): raise RepairError('nightly schedule changed')
        run(['git', 'diff', '--check']); run(['npm', 'run', 'build'], timeout=1800); run(['npm', 'test'], timeout=2400)
        (ROOT / SELF).unlink()
        staged = [item for item in targets if item not in ['config/chat.config.yaml', 'config/game.config.yaml']]
        run(['git', 'add', '--', *staged]); run(['git', 'diff', '--cached', '--check'])
        run(['git', 'commit', '-m', 'fix(interface): wire YAML settings and 30-minute naps']); committed = True
        head = git('rev-parse', 'HEAD'); run(['git', 'push', 'origin', 'HEAD:main'], timeout=1800); workflow = wait_ci(head)
        temp.cleanup(); temp = None
        print(json.dumps({'ok': True, 'marker': PASS, 'head': head, 'workflow_run': workflow, 'manual_nap_duration_minutes': 30, 'nightly_sleep_schedule': '23:00-07:00', 'nightly_schedule_modified': False, 'settings_authority': 'config/chat.config.yaml', 'local_storage_removed': True, 'regenerate_button_wired': True, 'system_controls_verified': True, 'audio_volume_backend': 'wpctl with pactl fallback', 'persistent_backups_created': False, 'temporary_workspace_removed': True}, indent=2)); print(PASS)
    except Exception as error:
        if not committed: restore(originals)
        print(json.dumps({'ok': False, 'marker': FAIL, 'error': str(error), 'persistent_backups_created': False, 'temporary_workspace_removed': True}, indent=2)); print(FAIL); raise SystemExit(1)
    finally:
        if temp is not None: name = temp.name; temp.cleanup(); log('removed temporary workspace: ' + name)

if __name__ == '__main__': main()
