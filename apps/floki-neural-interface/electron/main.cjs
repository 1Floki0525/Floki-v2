'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

if (process.platform === 'linux' && process.env.FLOKI_ELECTRON_ENABLE_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');

const APP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_INDEX = path.join(APP_ROOT, 'dist', 'index.html');
const { getLiveChatConfig, getVisionConfig, getSelfImprovementConfig } = require(path.join(PROJECT_ROOT, 'src/config/floki-config.cjs'));
const { runtimePaths } = require(path.join(PROJECT_ROOT, 'src/vision/chat-webcam-vision-service.cjs'));
const { createMjpegFileStreamServer } = require('./mjpeg-file-stream.cjs');
const { createRuntimeRequest } = require('./runtime-request.cjs');

const runtimeConfig = getLiveChatConfig('chat');
const visionConfig = getVisionConfig('chat');
const selfImprovementConfig = getSelfImprovementConfig('chat');
// Run Now blocks server-side until the sandbox actually starts (snapshot of the
// repo + self-context, then container creation), which can exceed the default
// stream timeout. Give this one call a client budget larger than the server's
// sandbox-start wait so the UI does not abort before the sandbox is up.
const RUN_NOW_REQUEST_TIMEOUT_MS =
  Number(selfImprovementConfig.run_now_ack_timeout_ms) + 30000;
const RUNTIME_URL = 'http://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port);
const { ensureApprovalToken } = require(path.join(PROJECT_ROOT, 'src/self-improvement/store.cjs'));
const SELF_IMPROVEMENT_APPROVAL_TOKEN = ensureApprovalToken();
const SHARED_RUNTIME_CLIENT = process.env.FLOKI_ELECTRON_SHARED_RUNTIME_CLIENT === '1';

let mainWindow = null;
let requestInFlight = false;
let mjpegTransport = null;
let rendererUnresponsiveTimer = null;

const runtimeRequest = createRuntimeRequest({
  base_url: RUNTIME_URL,
  timeout_ms: Number(runtimeConfig.stream_timeout_ms)
});

function cleanupMjpeg() {
  if (!mjpegTransport) return;
  mjpegTransport.close();
  mjpegTransport = null;
}

function clearRendererUnresponsiveTimer() {
  if (!rendererUnresponsiveTimer) return;
  clearTimeout(rendererUnresponsiveTimer);
  rendererUnresponsiveTimer = null;
}

function armRendererUnresponsiveTimer() {
  clearRendererUnresponsiveTimer();
  const graceMs = Math.max(
    Number(runtimeConfig.runtime_watchdog_request_timeout_ms || 0),
    Number(runtimeConfig.renderer_unresponsive_grace_ms || 15000)
  );
  console.error('FLOKI_V2_ELECTRON_RENDERER_UNRESPONSIVE grace_ms=' + String(graceMs));
  rendererUnresponsiveTimer = setTimeout(() => {
    console.error('FLOKI_V2_ELECTRON_RENDERER_CRASH reason=renderer_unresponsive_timeout grace_ms=' + String(graceMs));
    app.exit(1);
  }, graceMs);
  if (typeof rendererUnresponsiveTimer.unref === 'function') rendererUnresponsiveTimer.unref();
}

function attachRendererLifecycleHandlers(window) {
  window.on('unresponsive', () => {
    armRendererUnresponsiveTimer();
  });
  window.on('responsive', () => {
    clearRendererUnresponsiveTimer();
    console.error('FLOKI_V2_ELECTRON_RENDERER_RECOVERED');
  });
  window.webContents.on('render-process-gone', (_event, details = {}) => {
    clearRendererUnresponsiveTimer();
    console.error('FLOKI_V2_ELECTRON_RENDERER_CRASH reason=' + String(details.reason || 'unknown') + ' exit_code=' + String(details.exitCode ?? 'unknown'));
    app.exit(1);
  });
  window.webContents.on('child-process-gone', (_event, details = {}) => {
    console.error('FLOKI_V2_ELECTRON_CHILD_PROCESS_GONE type=' + String(details.type || 'unknown') + ' reason=' + String(details.reason || 'unknown') + ' exit_code=' + String(details.exitCode ?? 'unknown'));
  });
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
      kind: String(payload.kind || 'code'),
      token: SELF_IMPROVEMENT_APPROVAL_TOKEN
    }, RUN_NOW_REQUEST_TIMEOUT_MS)
  );
  ipcMain.handle('floki:abort-self-improvement', async (_event, payload = {}) =>
    runtimeRequest('POST', '/self-improvement/abort', {
      kind: String(payload.kind || 'code'),
      reason: String(payload.reason || ''),
      token: SELF_IMPROVEMENT_APPROVAL_TOKEN
    })
  );
  ipcMain.handle('floki:get-self-improvement-activity', async (_event, payload = {}) => {
    const params = new URLSearchParams();
    if (payload.init) params.set('init', 'true');
    if (payload.audit_cursor != null) params.set('audit_cursor', String(payload.audit_cursor));
    if (payload.sandbox_cursor != null) params.set('sandbox_cursor', String(payload.sandbox_cursor));
    if (payload.limit != null) params.set('limit', String(payload.limit));
    return runtimeRequest('GET', '/self-improvement/activity?' + params.toString());
  });
  ipcMain.handle('floki:get-self-improvement-terminal', async (_event, payload = {}) => {
    const params = new URLSearchParams();
    if (payload.cursor != null) params.set('cursor', String(payload.cursor));
    if (payload.before_cursor != null) params.set('before_cursor', String(payload.before_cursor));
    if (payload.max_bytes != null) params.set('max_bytes', String(payload.max_bytes));
    if (payload.source_id) params.set('source_id', String(payload.source_id));
    return runtimeRequest('GET', '/self-improvement/terminal?' + params.toString());
  });
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
  ipcMain.handle('floki:send-voice-utterance', async (_event, payload = {}) => {
    const base64 = String(payload.base64 || '');
    if (!base64) throw new Error('voice audio payload is required');
    if (requestInFlight) throw new Error('Floki is already responding');
    requestInFlight = true;
    try {
      const bytes = Buffer.from(base64, 'base64');
      const response = await fetch(RUNTIME_URL + '/audio/remote-utterance', {
        method: 'POST',
        headers: {
          'content-type': String(payload.contentType || 'audio/wav'),
          connection: 'close'
        },
        body: bytes,
        signal: AbortSignal.timeout(Number(runtimeConfig.stream_timeout_ms))
      });
      const raw = await response.text();
      const parsed = raw ? JSON.parse(raw) : {};
      if (!response.ok) throw new Error(parsed.error || 'runtime HTTP ' + String(response.status));
      return parsed;
    } finally {
      requestInFlight = false;
    }
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
  ipcMain.handle('floki:control-module', (_event, payload = {}) => {
    const moduleKey = encodeURIComponent(String(payload.moduleKey || ''));
    const action = String(payload.action || '') === 'restart' ? 'reset' : String(payload.action || '');
    return runtimeRequest('POST', '/control/modules/' + moduleKey + '/' + encodeURIComponent(action), {});
  });
  ipcMain.handle('floki:client-app-heartbeat', (_event, payload = {}) =>
    runtimeRequest('POST', '/interface/client-app/heartbeat', {
      app_key: String(payload.app_key || ''),
      client_id: String(payload.client_id || ''),
      session_id: String(payload.session_id || payload.client_id || ''),
      transport_type: String(payload.transport_type || 'electron-bridge'),
      healthy: payload.healthy !== false,
      error: payload.error || null
    })
  );
  ipcMain.handle('floki:open-log', async (_event, payload = {}) => {
    const result = await runtimeRequest(
      'GET',
      '/interface/log/' +
        encodeURIComponent(
          String(payload.service || '')
        )
    );
    if (
      result?.exists !== true ||
      typeof result?.text !== 'string'
    ) {
      throw new Error(
        result?.error ||
        'The selected current-week log is unavailable.'
      );
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
  ipcMain.handle('floki:get-runtime-websocket-url', () => 'ws://' + runtimeConfig.runtime_host + ':' + String(runtimeConfig.runtime_port) + '/ws');
}

async function ensureRuntime() {
  const status = await runtimeRequest('GET', '/status');
  if (status.api_ready !== true || status.brain_loaded !== true || status.websocket_ready !== true) throw new Error('authoritative chat.local runtime is not ready');
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1100, minHeight: 720, backgroundColor: '#030712', title: 'Floki Neural Interface', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWindow.setMenuBarVisibility(false);
  attachRendererLifecycleHandlers(mainWindow);
  mainWindow.loadFile(DIST_INDEX);
  mainWindow.once('ready-to-show', () => { mainWindow.show(); void runtimeRequest('POST', '/client-ready', {}).catch((error) => console.error('FLOKI_V2_CLIENT_READY_SIGNAL_FAIL: ' + error.message)); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => {
    if (!SHARED_RUNTIME_CLIENT) {
      void runtimeRequest(
        'POST',
        '/client-detached',
        {}
      ).catch((error) => console.error(
        'FLOKI_V2_CLIENT_DETACHED_SIGNAL_FAIL: ' +
        error.message
      ));
    }
    mainWindow = null;
    cleanupMjpeg();
  });
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
app.on('before-quit', () => { console.error('FLOKI_V2_ELECTRON_BEFORE_QUIT'); });
app.on('will-quit', () => { clearRendererUnresponsiveTimer(); console.error('FLOKI_V2_ELECTRON_WILL_QUIT'); });
app.on('quit', (_event, exitCode) => { console.error('FLOKI_V2_ELECTRON_QUIT code=' + String(exitCode)); });
