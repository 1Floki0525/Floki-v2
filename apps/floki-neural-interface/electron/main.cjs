'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

if (process.platform === 'linux' && process.env.FLOKI_ELECTRON_ENABLE_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');

const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');
const { getLiveChatConfig, getVisionConfig } = require(path.join(PROJECT_ROOT, 'src/config/floki-config.cjs'));
const { runtimePaths } = require(path.join(PROJECT_ROOT, 'src/vision/chat-webcam-vision-service.cjs'));
const { createMjpegFileStreamServer } = require('./mjpeg-file-stream.cjs');

const runtimeConfig = getLiveChatConfig('chat');
const visionConfig = getVisionConfig('chat');
const RUNTIME_URL = 'http://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port);
const { ensureApprovalToken } = require(path.join(PROJECT_ROOT, 'src/self-improvement/store.cjs'));
const SELF_IMPROVEMENT_APPROVAL_TOKEN = ensureApprovalToken();

let mainWindow = null;
let requestInFlight = false;
let mjpegTransport = null;

async function runtimeRequest(method, pathname, body = null) {
  const response = await fetch(RUNTIME_URL + pathname, {
    method,
    headers: body === null ? undefined : { 'content-type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(runtimeConfig.stream_timeout_ms))
  });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch (error) { throw new Error('authoritative runtime returned invalid JSON: ' + error.message); }
  }
  if (!response.ok) throw new Error(payload.error || `runtime HTTP ${response.status}`);
  return payload;
}

function cleanupMjpeg() {
  if (!mjpegTransport) return;
  mjpegTransport.close();
  mjpegTransport = null;
}

function startMjpegFileStream() {
  if (!mjpegTransport) {
    const freshnessMs = Math.max(
      100,
      Number(visionConfig.frame_retention_seconds || 0) * 1000 +
        Number(visionConfig.capture_timeout_grace_ms || 0)
    );
    const watchIntervalMs = Math.max(
      25,
      Math.floor(1000 / Math.max(1, Number(visionConfig.target_capture_fps || 1)))
    );
    mjpegTransport = createMjpegFileStreamServer({
      frame_file: runtimePaths().latest_frame_file,
      freshness_ms: freshnessMs,
      watch_interval_ms: watchIntervalMs,
      on_error: (error) => console.error('FLOKI_V2_MJPEG_FILE_STREAM_FAIL: ' + error.message)
    });
  }
  return mjpegTransport.start();
}

function registerIpc() {
  ipcMain.handle('floki:get-self-improvement-status', async () => {
    const result = await runtimeRequest('GET', '/self-improvement/status');
    return result.status;
  });
  ipcMain.handle('floki:get-self-improvement-candidates', async () => {
    const result = await runtimeRequest('GET', '/self-improvement/candidates');
    return result.candidates || [];
  });
  ipcMain.handle('floki:get-self-improvement-candidate', async (_event, payload = {}) => {
    const id = encodeURIComponent(String(payload.id || ''));
    const result = await runtimeRequest('GET', '/self-improvement/candidates/' + id);
    return result.candidate;
  });
  ipcMain.handle('floki:approve-self-improvement', async (_event, payload = {}) =>
    runtimeRequest('POST', '/self-improvement/approve', {
      id: String(payload.id || ''),
      token: SELF_IMPROVEMENT_APPROVAL_TOKEN
    })
  );
  ipcMain.handle('floki:deny-self-improvement', async (_event, payload = {}) =>
    runtimeRequest('POST', '/self-improvement/deny', {
      id: String(payload.id || ''),
      reason: String(payload.reason || ''),
      token: SELF_IMPROVEMENT_APPROVAL_TOKEN
    })
  );
  ipcMain.handle('floki:pause-self-improvement', async () =>
    runtimeRequest('POST', '/self-improvement/pause', { token: SELF_IMPROVEMENT_APPROVAL_TOKEN })
  );
  ipcMain.handle('floki:resume-self-improvement', async () =>
    runtimeRequest('POST', '/self-improvement/resume', { token: SELF_IMPROVEMENT_APPROVAL_TOKEN })
  );
  ipcMain.handle('floki:run-self-improvement-now', async (_event, payload = {}) =>
    runtimeRequest('POST', '/self-improvement/run-now', {
      objective: String(payload.objective || ''),
      token: SELF_IMPROVEMENT_APPROVAL_TOKEN
    })
  );
  ipcMain.handle('floki:get-initial-status', () => runtimeRequest('GET', '/interface/status'));
  ipcMain.handle('floki:get-system-status', () => runtimeRequest('GET', '/interface/services'));
  ipcMain.handle('floki:get-transcript', (_event, payload = {}) => runtimeRequest('GET', '/interface/transcript?limit=' + encodeURIComponent(String(payload.limit || 200))));
  ipcMain.handle('floki:clear-transcript', () => runtimeRequest('POST', '/transcript/clear', {}));
  ipcMain.handle('floki:send-message', async (_event, payload = {}) => {
    const text = String(payload.text || '').trim();
    if (!text) throw new Error('message text is required');
    if (requestInFlight) throw new Error('Floki is already responding');
    requestInFlight = true;
    try { return await runtimeRequest('POST', '/chat', { text }); }
    finally { requestInFlight = false; }
  });
  ipcMain.handle('floki:interrupt', () => runtimeRequest('POST', '/interrupt', {}));
  ipcMain.handle('floki:get-vision-frame', () => runtimeRequest('GET', '/interface/vision/frame'));
  ipcMain.handle('floki:get-latest-frame', async () => (await runtimeRequest('GET', '/interface/vision/frame/base64')).data || null);
  ipcMain.handle('floki:get-mjpeg-port', () => startMjpegFileStream());
  ipcMain.handle('floki:get-observation', () => runtimeRequest('GET', '/interface/vision/observation'));
  ipcMain.handle('floki:get-emotion', () => runtimeRequest('GET', '/interface/emotion'));
  ipcMain.handle('floki:get-affect-history', (_event, payload = {}) => runtimeRequest('GET', '/interface/emotion/history?limit=' + encodeURIComponent(String(payload.limit || 360))));
  ipcMain.handle('floki:get-sleep-status', () => runtimeRequest('GET', '/interface/sleep'));
  ipcMain.handle('floki:get-neural-events', (_event, payload = {}) => runtimeRequest('GET', '/interface/neural?limit=' + encodeURIComponent(String(payload.limit || 250))));
  ipcMain.handle('floki:get-dream-timeline', () => runtimeRequest('GET', '/interface/dreams'));
  ipcMain.handle('floki:get-settings', () => runtimeRequest('GET', '/interface/settings'));
  ipcMain.handle('floki:update-settings', (_event, payload = {}) => runtimeRequest('POST', '/interface/settings/update', { section: payload.section, values: payload.values || {} }));
  ipcMain.handle('floki:reset-settings', (_event, payload = {}) => runtimeRequest('POST', '/interface/settings/reset', { section: payload.section }));
  ipcMain.handle('floki:reset-all-settings', () => runtimeRequest('POST', '/interface/settings/reset', { section: null }));
  ipcMain.handle('floki:import-settings', (_event, payload = {}) => runtimeRequest('POST', '/interface/settings/import', { settings: payload.settings || {} }));
  ipcMain.handle('floki:push-to-talk', (_event, payload = {}) => runtimeRequest('POST', '/audio/push-to-talk', { active: payload.active === true }));
  ipcMain.handle('floki:control', (_event, payload = {}) => runtimeRequest('POST', '/interface/control/' + encodeURIComponent(String(payload.action || '')), { argument: payload.argument }));
  ipcMain.handle('floki:open-log', async (_event, payload = {}) => {
    const result = await runtimeRequest('GET', '/interface/log/' + encodeURIComponent(String(payload.service || '')));
    if (!result.exists || !result.path) throw new Error('The selected backend log is not available.');
    const openError = await shell.openPath(result.path);
    if (openError) throw new Error(openError);
    return { ok: true, file: result.path };
  });
  ipcMain.handle('floki:get-runtime-websocket-url', () => 'ws://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port) + '/ws');
}

async function ensureRuntime() {
  const status = await runtimeRequest('GET', '/status');
  if (status.api_ready !== true || status.brain_loaded !== true || status.websocket_ready !== true) throw new Error('authoritative chat.local runtime is not ready');
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1100, minHeight: 720, backgroundColor: '#030712', title: 'Floki Neural Interface', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(DIST_INDEX);
  mainWindow.once('ready-to-show', () => { mainWindow.show(); void runtimeRequest('POST', '/client-ready', {}).catch((error) => console.error('FLOKI_V2_CLIENT_READY_SIGNAL_FAIL: ' + error.message)); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => { void runtimeRequest('POST', '/client-detached', {}).catch((error) => console.error('FLOKI_V2_CLIENT_DETACHED_SIGNAL_FAIL: ' + error.message)); mainWindow = null; cleanupMjpeg(); });
}

app.whenReady().then(async () => {
  const fs = require('node:fs');
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built interface missing: ${DIST_INDEX}`);
  await ensureRuntime();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => { console.error('FLOKI_V2_ELECTRON_STARTUP_FAIL: ' + String(error && error.stack ? error.stack : error)); app.exit(1); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
