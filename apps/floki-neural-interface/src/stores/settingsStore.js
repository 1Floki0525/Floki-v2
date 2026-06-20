const STORAGE_KEY = 'floki-neural-settings'

const DEFAULT_SETTINGS = {
  connection: {
    autoReconnect: true,
    reconnectDelay: 3000,
    requestTimeout: 120000,
  },
  latency: {
    firstTokenTarget: 500,
    firstSpokenAudioTarget: 1500,
    slowWarningThreshold: 2000,
    criticalThreshold: 5000,
    showDetailedStageTiming: true,
  },
}

function deepMerge(target, source) {
  const result = { ...target }
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key]) {
      result[key] = deepMerge(target[key], source[key])
    } else if (Object.prototype.hasOwnProperty.call(target, key)) {
      result[key] = source[key]
    }
  }
  return result
}

function loadSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? deepMerge(DEFAULT_SETTINGS, JSON.parse(stored)) : deepMerge(DEFAULT_SETTINGS, {})
  } catch (_error) {
    return deepMerge(DEFAULT_SETTINGS, {})
  }
}

let currentSettings = loadSettings()
let listeners = []

export function getSettings() { return currentSettings }

export function updateSettings(section, values) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, section)) throw new Error(`Unknown settings section: ${section}`)
  currentSettings = { ...currentSettings, [section]: { ...currentSettings[section], ...values } }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings))
  listeners.forEach((fn) => fn(currentSettings))
}

export function resetSection(section) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, section)) throw new Error(`Unknown settings section: ${section}`)
  currentSettings = { ...currentSettings, [section]: { ...DEFAULT_SETTINGS[section] } }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings))
  listeners.forEach((fn) => fn(currentSettings))
}

export function resetAllSettings() {
  currentSettings = deepMerge(DEFAULT_SETTINGS, {})
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings))
  listeners.forEach((fn) => fn(currentSettings))
}

export function exportSettings() { return JSON.stringify(currentSettings, null, 2) }

export function importSettings(json) {
  currentSettings = deepMerge(DEFAULT_SETTINGS, JSON.parse(json))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings))
  listeners.forEach((fn) => fn(currentSettings))
}

export function subscribeSettings(fn) {
  listeners.push(fn)
  return () => { listeners = listeners.filter((listener) => listener !== fn) }
}

export function getDefaultSettings() { return DEFAULT_SETTINGS }
