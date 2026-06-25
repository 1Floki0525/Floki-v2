'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadYamlFile } = require('./yaml-lite.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 3;
const DEFAULTS = Object.freeze({
  version: VERSION,
  connection: { transport: 'electron-ipc', localApiUrl: 'http://127.0.0.1:7700', localWsUrl: 'ws://127.0.0.1:7700/ws', autoReconnect: true, reconnectDelay: 3000, reconnectJitterMs: 500, reconnectBackoffMaxMs: 30000, maxReconnectAttempts: 0, requestTimeout: 120000, mockMode: false },
  chat: { streamResponses: true, showTimestamps: true, markdownRendering: true, compactMessages: false, enterToSend: true, maxLocalHistory: 500, transcriptPollMs: 750 },
  voice: { microphoneEnabled: true, speakerEnabled: true, handsFreeListening: true, pushToTalk: false, wakeWordEnabled: true, wakePhrase: 'Hey Floki', speechVolume: 80, speechRate: 1, interruptibleSpeech: true, showPartialTranscription: true },
  vision: { showObjectBoxes: true, showPersonBoxes: true, showFaceBoxes: true, showRecognizedNames: true, showLabels: true, showConfidence: true, showSceneRecognition: true, observationFreshnessThreshold: 30, detectionDisplayTtlMs: 2500, staleObservationWarning: true, privacyBlackoutDefault: false },
  emotions: { graphTimeRange: '5m', updateFrequency: 2000, graphSmoothing: 0.3 },
  neuralStream: { autoScroll: true, maxEvents: 1000, dedupeWindowMs: 900000, sessionOnly: true, compactView: false, defaultPrivacyFilter: 'all' },
  appearance: { neonIntensity: 70, glowIntensity: 50, animationLevel: 'normal', fontSize: 14, interfaceScale: 100, panelDensity: 'comfortable', reducedMotion: false },
  latency: { firstTokenTarget: 500, firstSpokenAudioTarget: 1500, slowWarningThreshold: 2000, criticalThreshold: 5000, showDetailedStageTiming: true },
  privacy: { hideVisionByDefault: false, hideRecognizedNames: false, redactPrivateMetadata: false, allowLocalExport: true, clearStoredPreferences: false }
});
const MAP = Object.freeze({
  connection: { transport: 'transport', localApiUrl: 'local_api_url', localWsUrl: 'local_ws_url', autoReconnect: 'auto_reconnect', reconnectDelay: 'reconnect_delay_ms', reconnectJitterMs: 'reconnect_jitter_ms', reconnectBackoffMaxMs: 'reconnect_backoff_max_ms', maxReconnectAttempts: 'max_reconnect_attempts', requestTimeout: 'request_timeout_ms', mockMode: 'mock_mode' },
  chat: { streamResponses: 'stream_responses', showTimestamps: 'show_timestamps', markdownRendering: 'markdown_rendering', compactMessages: 'compact_messages', enterToSend: 'enter_to_send', maxLocalHistory: 'max_local_history', transcriptPollMs: 'transcript_poll_ms' },
  voice: { microphoneEnabled: 'microphone_enabled', speakerEnabled: 'speaker_enabled', handsFreeListening: 'hands_free_listening', pushToTalk: 'push_to_talk', wakeWordEnabled: 'wake_word_enabled', wakePhrase: 'wake_phrase', speechVolume: 'speech_volume', speechRate: 'speech_rate', interruptibleSpeech: 'interruptible_speech', showPartialTranscription: 'show_partial_transcription' },
  vision: { showObjectBoxes: 'show_object_boxes', showPersonBoxes: 'show_person_boxes', showFaceBoxes: 'show_face_boxes', showRecognizedNames: 'show_recognized_names', showLabels: 'show_labels', showConfidence: 'show_confidence', showSceneRecognition: 'show_scene_recognition', observationFreshnessThreshold: 'observation_freshness_threshold', detectionDisplayTtlMs: 'detection_display_ttl_ms', staleObservationWarning: 'stale_observation_warning', privacyBlackoutDefault: 'privacy_blackout_default' },
  emotions: { graphTimeRange: 'graph_time_range', updateFrequency: 'update_frequency', graphSmoothing: 'graph_smoothing' },
  neuralStream: { autoScroll: 'auto_scroll', maxEvents: 'max_events', dedupeWindowMs: 'dedupe_window_ms', sessionOnly: 'session_only', compactView: 'compact_view', defaultPrivacyFilter: 'default_privacy_filter' },
  appearance: { neonIntensity: 'neon_intensity', glowIntensity: 'glow_intensity', animationLevel: 'animation_level', fontSize: 'font_size', interfaceScale: 'interface_scale', panelDensity: 'panel_density', reducedMotion: 'reduced_motion' },
  latency: { firstTokenTarget: 'first_token_target', firstSpokenAudioTarget: 'first_spoken_audio_target', slowWarningThreshold: 'slow_warning_threshold', criticalThreshold: 'critical_threshold', showDetailedStageTiming: 'show_detailed_stage_timing' },
  privacy: { hideVisionByDefault: 'hide_vision_by_default', hideRecognizedNames: 'hide_recognized_names', redactPrivateMetadata: 'redact_private_metadata', allowLocalExport: 'allow_local_export', clearStoredPreferences: 'clear_stored_preferences' }
});
const RANGE = Object.freeze({
  'connection.reconnectDelay': [1000, 30000], 'connection.reconnectJitterMs': [0, 30000], 'connection.reconnectBackoffMaxMs': [1000, 300000], 'connection.maxReconnectAttempts': [0, 1000], 'connection.requestTimeout': [5000, 300000], 'chat.maxLocalHistory': [50, 5000], 'chat.transcriptPollMs': [100, 5000],
  'voice.speechVolume': [0, 100], 'voice.speechRate': [0.5, 2], 'vision.observationFreshnessThreshold': [5, 120], 'vision.detectionDisplayTtlMs': [250, 30000],
  'emotions.updateFrequency': [500, 10000], 'emotions.graphSmoothing': [0, 1], 'neuralStream.maxEvents': [100, 10000], 'neuralStream.dedupeWindowMs': [0, 86400000],
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
