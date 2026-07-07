'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (process.platform === 'linux' && process.env.FLOKI_ELECTRON_ENABLE_GPU_SANDBOX !== '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
// The side widget relies on programmatic right-edge positioning. Electron
// documents Wayland limitations for setBounds/setPosition, so prefer X11 on
// Linux unless the user explicitly opts out.
if (
  process.platform === 'linux' &&
  String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' &&
  process.env.FLOKI_WIDGET_FORCE_WAYLAND !== '1'
) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');
const APP_ICON = path.join(PROJECT_ROOT, 'apps', 'assets', 'floki-icon.png');
const WIDGET_PID_FILE = String(process.env.FLOKI_DESKTOP_WIDGET_PID_FILE || '').trim();
const WIDGET_READY_FILE = String(process.env.FLOKI_DESKTOP_WIDGET_READY_FILE || '').trim();

const {
  getLiveChatConfig,
  getPathConfig
} = require(path.join(PROJECT_ROOT, 'src/config/floki-config.cjs'));
const { createRuntimeRequest } = require('./runtime-request.cjs');

const runtimeConfig = getLiveChatConfig('chat');
const paths = getPathConfig('chat');
const runtimeDir = path.resolve(PROJECT_ROOT, paths.chat_runtime_root);
const RUNTIME_URL = 'http://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port);
const runtimeRequest = createRuntimeRequest({
  base_url: RUNTIME_URL,
  timeout_ms: Number(runtimeConfig.stream_timeout_ms)
});

const COLLAPSED_WIDTH = 42;
const EXPANDED_WIDTH = 430;
const MIN_HEIGHT = 460;
const MAX_HEIGHT = 760;

let widgetWindow = null;
let expanded = false;
let pollTimer = null;

app.setName('Floki Status Widget');
if (process.platform === 'linux') {
  app.setDesktopName('floki.desktop.widget.desktop');
}

function writePidFile() {
  if (!WIDGET_PID_FILE) return;
  fs.mkdirSync(path.dirname(WIDGET_PID_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(WIDGET_PID_FILE, String(process.pid) + '\n', { mode: 0o600 });
}

function removeRuntimeMarkers() {
  for (const file of [WIDGET_PID_FILE, WIDGET_READY_FILE]) {
    if (!file) continue;
    try { fs.rmSync(file, { force: true }); } catch (_error) {}
  }
}

function writeReadyMarker() {
  if (!WIDGET_READY_FILE || !widgetWindow || widgetWindow.isDestroyed()) return;
  fs.mkdirSync(path.dirname(WIDGET_READY_FILE), { recursive: true, mode: 0o700 });
  const temp = WIDGET_READY_FILE + '.tmp-' + String(process.pid);
  fs.writeFileSync(temp, JSON.stringify({
    marker: 'FLOKI_DESKTOP_SIDE_WIDGET_READY',
    pid: process.pid,
    window_id: widgetWindow.id,
    expanded,
    runtime_url: RUNTIME_URL,
    ready_at: new Date().toISOString()
  }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, WIDGET_READY_FILE);
}

function displayWorkArea() {
  const display = screen.getPrimaryDisplay();
  return display.workArea || {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  };
}

function widgetBounds(nextExpanded = expanded) {
  const work = displayWorkArea();
  const width = nextExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(MAX_HEIGHT, Math.max(120, Number(work.height || 0) - 80))
  );
  return {
    x: Math.round(Number(work.x || 0) + Number(work.width || 0) - width),
    y: Math.round(Number(work.y || 0) + Math.max(20, (Number(work.height || height) - height) / 2)),
    width,
    height
  };
}

function applyWidgetBounds(nextExpanded) {
  expanded = nextExpanded === true;
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.setBounds(widgetBounds(expanded));
  widgetWindow.setAlwaysOnTop(true, 'floating');
  widgetWindow.setSkipTaskbar(true);
  widgetWindow.webContents.send('floki-widget:state', {
    expanded,
    bounds: widgetWindow.getBounds()
  });
  writeReadyMarker();
}

async function ensureRuntime() {
  const status = await runtimeRequest('GET', '/status');
  if (status.api_ready !== true || status.brain_loaded !== true) {
    throw new Error('authoritative chat.local runtime is not ready');
  }
}

function registerIpc() {
  ipcMain.handle('floki:get-initial-status', () => runtimeRequest('GET', '/interface/status'));
  ipcMain.handle('floki:get-system-status', () => runtimeRequest('GET', '/interface/services'));
  ipcMain.handle('floki:control-module', (_event, payload = {}) => {
    const moduleKey = encodeURIComponent(String(payload.moduleKey || ''));
    const action = String(payload.action || '') === 'restart' ? 'reset' : String(payload.action || '');
    return runtimeRequest('POST', '/control/modules/' + moduleKey + '/' + encodeURIComponent(action), {});
  });
  ipcMain.handle('floki:client-app-heartbeat', (_event, payload = {}) =>
    runtimeRequest('POST', '/interface/client-app/heartbeat', {
      app_key: String(payload.app_key || 'desktop_widget'),
      client_id: String(payload.client_id || 'desktop-widget-' + String(process.pid)),
      session_id: String(payload.session_id || payload.client_id || 'desktop-widget-' + String(process.pid)),
      transport_type: String(payload.transport_type || 'electron-side-widget'),
      healthy: payload.healthy !== false,
      error: payload.error || null
    })
  );
  ipcMain.handle('floki:open-log', async (_event, payload = {}) => {
    const result = await runtimeRequest('GET', '/interface/log/' + encodeURIComponent(String(payload.service || '')));
    if (result?.exists !== true || typeof result?.text !== 'string') {
      throw new Error(result?.error || 'The selected current-week log is unavailable.');
    }
    return {
      ok: true,
      service: String(result.service || payload.service || ''),
      display_name: result.display_name || null,
      file_name: result.file_name || null,
      week: result.week || null,
      exists: true,
      text: String(result.text || ''),
      truncated: result.truncated === true,
      size_bytes: Number(result.size_bytes || 0),
      modified_at: result.modified_at || null
    };
  });
  ipcMain.handle('floki-widget:get-state', () => ({
    expanded,
    bounds: widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : null
  }));
  ipcMain.handle('floki-widget:expand', () => {
    applyWidgetBounds(true);
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show();
    return { ok: true, expanded };
  });
  ipcMain.handle('floki-widget:collapse', () => {
    applyWidgetBounds(false);
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.showInactive();
    return { ok: true, expanded };
  });
  ipcMain.handle('floki-widget:toggle', () => {
    applyWidgetBounds(!expanded);
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.show();
    return { ok: true, expanded };
  });
}

function heartbeatLoop() {
  if (pollTimer) clearInterval(pollTimer);
  const send = () => {
    runtimeRequest('POST', '/interface/client-app/heartbeat', {
      app_key: 'desktop_widget',
      client_id: 'desktop-widget-' + String(process.pid),
      session_id: 'desktop-widget-' + String(process.pid),
      transport_type: 'electron-side-widget',
      healthy: true,
      error: null
    }).catch(() => undefined);
  };
  send();
  pollTimer = setInterval(send, 5000);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function createWidget() {
  const bounds = widgetBounds(false);
  widgetWindow = new BrowserWindow({
    ...bounds,
    minWidth: COLLAPSED_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: EXPANDED_WIDTH,
    title: 'Floki Status Widget',
    icon: APP_ICON,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  widgetWindow.setMenuBarVisibility(false);
  if (process.platform === 'linux') widgetWindow.setIcon(APP_ICON);
  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widgetWindow.on('closed', () => {
    widgetWindow = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  });
  const widgetUrl = pathToFileURL(DIST_INDEX).toString() + '#/desktop-widget';
  widgetWindow.loadURL(widgetUrl);
  widgetWindow.once('ready-to-show', () => {
    applyWidgetBounds(false);
    widgetWindow.showInactive();
    writeReadyMarker();
  });
}

app.whenReady().then(async () => {
  removeRuntimeMarkers();
  writePidFile();
  if (!fs.existsSync(DIST_INDEX)) throw new Error('built interface missing: ' + DIST_INDEX);
  await ensureRuntime();
  registerIpc();
  createWidget();
  heartbeatLoop();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWidget();
  });
}).catch((error) => {
  console.error('FLOKI_DESKTOP_SIDE_WIDGET_STARTUP_FAIL: ' + String(error && error.stack ? error.stack : error));
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => console.error('FLOKI_DESKTOP_SIDE_WIDGET_BEFORE_QUIT'));
app.on('will-quit', () => {
  removeRuntimeMarkers();
  if (pollTimer) clearInterval(pollTimer);
  console.error('FLOKI_DESKTOP_SIDE_WIDGET_WILL_QUIT');
});
app.on('quit', (_event, exitCode) => console.error('FLOKI_DESKTOP_SIDE_WIDGET_QUIT code=' + String(exitCode)));
