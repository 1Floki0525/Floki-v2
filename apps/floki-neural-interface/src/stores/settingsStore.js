const STORAGE_KEY = 'floki-neural-settings'
const SETTINGS_VERSION = 2

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  connection: {
    transport: 'electron-ipc',
    localApiUrl: 'http://localhost:7700',
    localWsUrl: 'ws://localhost:7700/ws',
    autoReconnect: true,
    reconnectDelay: 3000,
    requestTimeout: 120000,
    mockMode: false,
  },
  chat: {
    streamResponses: true,
    showTimestamps: true,
    markdownRendering: true,
    compactMessages: false,
    enterToSend: true,
    maxLocalHistory: 500,
  },
  voice: {
    microphoneEnabled: true,
    speakerEnabled: true,
    handsFreeListening: true,
    pushToTalk: false,
    wakeWordEnabled: true,
    wakePhrase: 'Hey Floki',
    speechVolume: 80,
    speechRate: 1.0,
    interruptibleSpeech: true,
    showPartialTranscription: true,
  },
  vision: {
    showObjectBoxes: true,
    showPersonBoxes: true,
    showFaceBoxes: true,
    showRecognizedNames: true,
    showLabels: true,
    showConfidence: true,
    showSceneRecognition: true,
    observationFreshnessThreshold: 30,
    staleObservationWarning: true,
    privacyBlackoutDefault: false,
  },
  emotions: {
    visibleChannels: ['valence', 'arousal', 'trust', 'curiosity', 'hope', 'fear', 'frustration', 'attachment', 'confidence', 'uncertainty'],
    graphTimeRange: '5m',
    updateFrequency: 2000,
    graphSmoothing: 0.3,
  },
  neuralStream: {
    visibleModules: ['Hearing', 'Vision', 'Thalamus', 'Temporal', 'Amygdala', 'Emotions', 'Hippocampus', 'Memory', 'Personality', 'Pineal', 'Frontal', 'Broca', 'Sleep', 'REM', 'Dream', 'System'],
    autoScroll: true,
    maxEvents: 1000,
    defaultPrivacyFilter: 'all',
    compactView: false,
  },
  appearance: {
    neonIntensity: 70,
    glowIntensity: 50,
    animationLevel: 'normal',
    fontSize: 14,
    interfaceScale: 100,
    panelDensity: 'comfortable',
    reducedMotion: false,
  },
  latency: {
    firstTokenTarget: 500,
    firstSpokenAudioTarget: 1500,
    slowWarningThreshold: 2000,
    criticalThreshold: 5000,
    showDetailedStageTiming: true,
  },
  privacy: {
    hideVisionByDefault: false,
    hideRecognizedNames: false,
    redactPrivateMetadata: false,
    allowLocalExport: true,
    clearStoredPreferences: false,
  },
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepMerge(target, source) {
  const result = clone(target)
  for (const key of Object.keys(source || {})) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) continue
    const sourceValue = source[key]
    const targetValue = target[key]
    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue)
    } else {
      result[key] = sourceValue
    }
  }
  return result
}

function persist(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

function loadSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const parsed = stored ? JSON.parse(stored) : {}
    const merged = deepMerge(DEFAULT_SETTINGS, parsed)
    merged.version = SETTINGS_VERSION
    return merged
  } catch (_error) {
    return clone(DEFAULT_SETTINGS)
  }
}

let currentSettings = loadSettings()
let listeners = []

export function getSettings() {
  return currentSettings
}

export function updateSettings(section, values) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, section)) {
    throw new Error(`Unknown settings section: ${section}`)
  }
  currentSettings = {
    ...currentSettings,
    [section]: {
      ...currentSettings[section],
      ...values,
    },
  }
  persist(currentSettings)
  listeners.forEach((listener) => listener(currentSettings))
}

export function resetSection(section) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, section)) {
    throw new Error(`Unknown settings section: ${section}`)
  }
  currentSettings = {
    ...currentSettings,
    [section]: clone(DEFAULT_SETTINGS[section]),
  }
  persist(currentSettings)
  listeners.forEach((listener) => listener(currentSettings))
}

export function resetAllSettings() {
  currentSettings = clone(DEFAULT_SETTINGS)
  persist(currentSettings)
  listeners.forEach((listener) => listener(currentSettings))
}

export function clearStoredSettings() {
  localStorage.removeItem(STORAGE_KEY)
  currentSettings = clone(DEFAULT_SETTINGS)
  listeners.forEach((listener) => listener(currentSettings))
}

export function exportSettings() {
  return JSON.stringify(currentSettings, null, 2)
}

export function importSettings(json) {
  const imported = JSON.parse(json)
  currentSettings = deepMerge(DEFAULT_SETTINGS, imported)
  currentSettings.version = SETTINGS_VERSION
  persist(currentSettings)
  listeners.forEach((listener) => listener(currentSettings))
}

export function subscribeSettings(listener) {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

export function getDefaultSettings() {
  return clone(DEFAULT_SETTINGS)
}
