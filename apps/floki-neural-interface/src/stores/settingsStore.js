let currentSettings = {
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
