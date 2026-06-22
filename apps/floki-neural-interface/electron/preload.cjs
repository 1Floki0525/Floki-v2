'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('floki', Object.freeze({
  getInitialStatus: () => invoke('floki:get-initial-status'),
  getSystemStatus: () => invoke('floki:get-system-status'),
  getTranscript: (limit = 200) => invoke('floki:get-transcript', { limit }),
  clearTranscript: () => invoke('floki:clear-transcript'),
  sendMessage: (text) => invoke('floki:send-message', { text }),
  interrupt: () => invoke('floki:interrupt'),
  getVisionFrame: () => invoke('floki:get-vision-frame'),
  getLatestFrame: () => invoke('floki:get-latest-frame'),
  getMjpegPort: () => invoke('floki:get-mjpeg-port'),
  getObservation: () => invoke('floki:get-observation'),
  getEmotion: () => invoke('floki:get-emotion'),
  getAffectHistory: (limit = 360) => invoke('floki:get-affect-history', { limit }),
  getSleepStatus: () => invoke('floki:get-sleep-status'),
  getNeuralEvents: (limit = 250) => invoke('floki:get-neural-events', { limit }),
  getDreamTimeline: () => invoke('floki:get-dream-timeline'),
  control: (action, argument = null) => invoke('floki:control', { action, argument }),
  openLog: (service) => invoke('floki:open-log', { service }),
  getSettings: () => invoke('floki:get-settings'),
  updateSettings: (section, values) => invoke('floki:update-settings', { section, values }),
  resetSettings: (section) => invoke('floki:reset-settings', { section }),
  resetAllSettings: () => invoke('floki:reset-all-settings'),
  importSettings: (settings) => invoke('floki:import-settings', { settings }),
  setPushToTalk: (active) => invoke('floki:push-to-talk', { active }),
}));
