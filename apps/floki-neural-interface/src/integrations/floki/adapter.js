import { FlokiState } from './types';

function hasBridge() {
  return typeof window !== 'undefined' && window.floki !== undefined;
}

function bridge() {
  if (!window.floki) throw new Error('Floki Electron bridge is unavailable');
  return window.floki;
}

const RUNTIME_API_BASE = (() => {
  if (typeof window !== 'undefined' && window.__FLOKI_RUNTIME_URL__) return window.__FLOKI_RUNTIME_URL__;
  if (
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:' &&
    window.location?.hostname === 'galactic-family-hub.com'
  ) {
    return 'https://api.galactic-family-hub.com';
  }
  return '/api/proxy';
})();

const RUNTIME_WS_URL = (() => {
  if (typeof window !== 'undefined' && window.__FLOKI_RUNTIME_WS_URL__) return window.__FLOKI_RUNTIME_WS_URL__;
  if (
    typeof window !== 'undefined' &&
    window.location?.protocol === 'https:' &&
    window.location?.hostname === 'galactic-family-hub.com'
  ) {
    return 'wss://api.galactic-family-hub.com/ws';
  }
  if (RUNTIME_API_BASE.startsWith('https://')) return RUNTIME_API_BASE.replace(/^https:/, 'wss:') + '/ws';
  if (RUNTIME_API_BASE.startsWith('http://')) return RUNTIME_API_BASE.replace(/^http:/, 'ws:') + '/ws';
  if (typeof window !== 'undefined' && window.location) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${RUNTIME_API_BASE}/ws`;
  }
  return null;
})();

const WEB_CLIENT_ID_KEY = 'floki_web_client_id_v1';
const WEB_APP_KEY = 'web_app';
let webClientId = null;
let normalWebTransportEnabled = true;
let observedWebGeneration = null;

function stableWebClientId() {
  if (webClientId) return webClientId;
  const fallback = () => 'web-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  try {
    const existing = window.localStorage.getItem(WEB_CLIENT_ID_KEY);
    if (existing && /^[A-Za-z0-9_.:-]{8,128}$/.test(existing)) {
      webClientId = existing;
      return webClientId;
    }
    webClientId = (typeof crypto !== 'undefined' && crypto.randomUUID ? 'web-' + crypto.randomUUID() : fallback()).slice(0, 128);
    window.localStorage.setItem(WEB_CLIENT_ID_KEY, webClientId);
    return webClientId;
  } catch (_error) {
    webClientId = fallback().slice(0, 128);
    return webClientId;
  }
}

function updateWebAppGateFromServices(services) {
  const web = Array.isArray(services) ? services.find((service) => service?.key === WEB_APP_KEY) : null;
  if (!web) return;
  normalWebTransportEnabled = web.enabled !== false && String(web.lifecycleState || '').toLowerCase() !== 'stopped';
  const generation = Number(web.controlGeneration);
  if (Number.isFinite(generation) && observedWebGeneration !== null && generation !== observedWebGeneration) {
    if (typeof window !== 'undefined' && window.location) window.location.reload();
  }
  if (Number.isFinite(generation)) observedWebGeneration = generation;
}

function assertNormalWebTransport(path) {
  if (normalWebTransportEnabled) return;
  if (/^\/(?:interface\/status|interface\/services|interface\/client-app\/heartbeat|control\/modules\/web_app\/(?:start|stop|reset)|health|status)\b/.test(path)) return;
  throw new Error('Web App service is stopped; start Web App from System to resume normal transport.');
}

async function runtimeHttpRequest(method, urlPath, body = null, options = {}) {
  assertNormalWebTransport(urlPath);
  const url = RUNTIME_API_BASE + urlPath;
  const requestOptions = {
    method,
    headers: {},
    credentials: 'include',
    signal: options.signal
  };
  if (options.rawBody != null) {
    requestOptions.headers['Content-Type'] = options.contentType || 'application/octet-stream';
    requestOptions.body = options.rawBody;
  } else if (body) {
    requestOptions.headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(body);
  }
  if (options.accept) requestOptions.headers.Accept = options.accept;
  const res = await fetch(url, requestOptions);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Runtime API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (options.raw === true) return res;
  if (contentType.includes('image')) return res;
  return res.json();
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(base64, contentType = 'audio/wav') {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

class FlokiAdapter {
  constructor() {
    this.webHeartbeatTimer = null;
    if (!hasBridge() && typeof window !== 'undefined') this.startWebHeartbeat();
  }

  startWebHeartbeat() {
    if (this.webHeartbeatTimer) return;
    const send = () => {
      this.clientAppHeartbeat(WEB_APP_KEY, { transportType: 'http-web' }).catch(() => undefined);
    };
    send();
    this.webHeartbeatTimer = window.setInterval(send, 5000);
  }

  async clientAppHeartbeat(appKey, options = {}) {
    const payload = {
      app_key: String(appKey || WEB_APP_KEY),
      client_id: stableWebClientId(),
      session_id: stableWebClientId(),
      transport_type: String(options.transportType || 'http-web'),
      healthy: options.healthy !== false,
      error: options.error || null
    };
    if (hasBridge()) return bridge().clientAppHeartbeat(payload);
    const result = await runtimeHttpRequest('POST', '/interface/client-app/heartbeat', payload);
    if (payload.app_key === WEB_APP_KEY && result?.app) {
      updateWebAppGateFromServices([{ key: WEB_APP_KEY, ...result.app, lifecycleState: result.app.status, enabled: result.app.enabled, controlGeneration: result.app.control_generation }]);
    }
    return result;
  }

  async getSystemStatus() {
    const rows = hasBridge() ? await bridge().getSystemStatus() : await runtimeHttpRequest('GET', '/interface/services');
    updateWebAppGateFromServices(rows);
    return rows;
  }
  async getVisionFrame() {
    if (hasBridge()) return bridge().getVisionFrame();
    return runtimeHttpRequest('GET', '/interface/vision/frame');
  }
  async getLatestFrame() {
    if (hasBridge()) return bridge().getLatestFrame();
    const frame = await runtimeHttpRequest('GET', '/interface/vision/frame/base64');
    return frame?.data || null;
  }
  async getMjpegPort() {
    if (hasBridge()) return bridge().getMjpegPort();
    return null;
  }
  async getMjpegUrl() {
    if (hasBridge()) {
      const port = await this.getMjpegPort();
      return port ? `http://127.0.0.1:${port}/live.mjpeg` : null;
    }
    return null;
  }
  async getVisionFrameUrl() {
    if (hasBridge()) {
      const port = await this.getMjpegPort();
      return port ? `http://127.0.0.1:${port}/live.mjpeg` : null;
    }
    return RUNTIME_API_BASE + '/interface/vision/frame/latest.jpg';
  }
  async getVisionFrameBlob(options = {}) {
    const response = await runtimeHttpRequest(
      'GET',
      '/interface/vision/frame/latest.jpg',
      null,
      {
        raw: true,
        accept: 'image/jpeg',
        signal: options.signal
      }
    );
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('image/jpeg')) {
      throw new Error('latest vision frame did not return image/jpeg');
    }
    return {
      blob: await response.blob(),
      timestamp: response.headers.get('x-floki-frame-timestamp') || null,
      ageMs: Number(response.headers.get('x-floki-frame-age-ms') || NaN)
    };
  }
  async getObservation() {
    if (hasBridge()) return bridge().getObservation();
    return runtimeHttpRequest('GET', '/interface/vision/observation');
  }
  async getEmotion() {
    if (hasBridge()) return bridge().getEmotion();
    return runtimeHttpRequest('GET', '/interface/emotion');
  }
  async getAffectHistory(limit = 360) {
    if (hasBridge()) return bridge().getAffectHistory(limit);
    return runtimeHttpRequest('GET', '/interface/emotion/history?limit=' + encodeURIComponent(String(limit)));
  }
  async getSleepStatus() {
    if (hasBridge()) return bridge().getSleepStatus();
    return runtimeHttpRequest('GET', '/interface/sleep');
  }
  async getNeuralEvents(limit = 250) {
    if (hasBridge()) return bridge().getNeuralEvents(limit);
    return runtimeHttpRequest('GET', '/interface/neural?limit=' + encodeURIComponent(String(limit)));
  }
  async getDreamTimeline() {
    if (hasBridge()) return bridge().getDreamTimeline();
    return runtimeHttpRequest('GET', '/interface/dreams');
  }
  async getInitialStatus() {
    if (hasBridge()) return bridge().getInitialStatus();
    return runtimeHttpRequest('GET', '/interface/status');
  }
  async getSettings() {
    if (hasBridge()) return bridge().getSettings();
    return runtimeHttpRequest('GET', '/interface/settings');
  }
  async getTranscript(limit = 200) {
    if (hasBridge()) return bridge().getTranscript(limit);
    return runtimeHttpRequest('GET', '/interface/transcript?limit=' + encodeURIComponent(String(limit)));
  }
  async clearTranscript() {
    if (hasBridge()) return bridge().clearTranscript();
    return runtimeHttpRequest('POST', '/transcript/clear', {});
  }
  async control(action, argument = null) {
    if (hasBridge()) return bridge().control(action, argument);
    return runtimeHttpRequest('POST', '/interface/control/' + encodeURIComponent(String(action || '')), { argument });
  }
  async controlModule(moduleKey, action) {
    const key = encodeURIComponent(String(moduleKey || ''));
    const op = action === 'restart' ? 'reset' : String(action || '');
    if (hasBridge()) return bridge().controlModule(moduleKey, op);
    const result = await runtimeHttpRequest('POST', '/control/modules/' + key + '/' + encodeURIComponent(op), {});
    if (moduleKey === WEB_APP_KEY && (op === 'start' || op === 'reset')) {
      normalWebTransportEnabled = true;
      await this.clientAppHeartbeat(WEB_APP_KEY, { transportType: 'http-web' }).catch(() => undefined);
    }
    return result;
  }
  async openLog(service) {
    if (hasBridge()) return bridge().openLog(service);
    return runtimeHttpRequest('GET', '/interface/log/' + encodeURIComponent(String(service || '')));
  }
  async interruptResponse() {
    if (hasBridge()) return bridge().interrupt();
    return runtimeHttpRequest('POST', '/interrupt', {});
  }
  async setPushToTalk(active) {
    if (hasBridge()) return bridge().setPushToTalk(active);
    return runtimeHttpRequest('POST', '/audio/push-to-talk', { active: active === true });
  }
  async subscribeRuntimeEvents(onEvent) {
    const [url, settings] = hasBridge()
      ? await Promise.all([
        bridge().getRuntimeWebSocketUrl(),
        bridge().getSettings(),
      ])
      : await Promise.all([
        Promise.resolve(RUNTIME_WS_URL),
        this.getSettings(),
      ]);
    if (!url) throw new Error('runtime WebSocket URL is unavailable');
      const autoReconnect = settings?.connection?.autoReconnect === true;
    const baseReconnectDelay = Number(settings?.connection?.reconnectDelay);
    const reconnectJitterMs = Number(settings?.connection?.reconnectJitterMs || 0);
    const reconnectBackoffMaxMs = Number(settings?.connection?.reconnectBackoffMaxMs || baseReconnectDelay);
    const maxReconnectAttempts = Number(settings?.connection?.maxReconnectAttempts || 0);
    if (!Number.isFinite(baseReconnectDelay) || baseReconnectDelay <= 0) {
      throw new Error('connection.reconnectDelay is missing from authoritative settings');
    }

    let stopped = false;
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let reconnectDelay = baseReconnectDelay;

    const scheduleReconnect = () => {
      if (stopped || !autoReconnect || reconnectTimer) return;
      if (
        Number.isFinite(maxReconnectAttempts) &&
        maxReconnectAttempts > 0 &&
        reconnectAttempts >= maxReconnectAttempts
      ) return;
      const jitter = reconnectJitterMs > 0 ? Math.floor(Math.random() * reconnectJitterMs) : 0;
      reconnectDelay = Math.min(
        baseReconnectDelay * (2 ** reconnectAttempts) + jitter,
        reconnectBackoffMaxMs
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempts += 1;
        connect();
      }, reconnectDelay);
    };

    const connect = () => {
      if (stopped) return;
      if (!normalWebTransportEnabled) return;
      if (socket && socket.readyState < WebSocket.CLOSING) return;
      socket = new WebSocket(url);
      socket.addEventListener('open', () => {
        reconnectAttempts = 0;
        reconnectDelay = baseReconnectDelay;
        onEvent({ type: 'stream.connected', data: { url } });
      });
      socket.addEventListener('message', (event) => {
        try {
          onEvent(JSON.parse(event.data));
        } catch (error) {
          console.error('invalid runtime event', error);
        }
      });
      socket.addEventListener('error', () => {
        onEvent({
          type: 'stream.error',
          data: { error: 'Authoritative runtime event stream disconnected.' },
        });
        scheduleReconnect();
      });
      socket.addEventListener('close', () => {
        socket = null;
        onEvent({ type: 'stream.closed', data: { url } });
        scheduleReconnect();
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }


  async sendMessage(text) {
    return bridge().sendMessage(text);
  }

  async sendChatMessage({ text, signal, onStateChange, onToken, onLatency, onError, onComplete }) {
    onStateChange?.(FlokiState.THINKING);
    const onAbort = () => {
      this.interruptResponse().catch((error) => console.error('interrupt request failed', error));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = hasBridge()
        ? await bridge().sendMessage(text)
        : await runtimeHttpRequest('POST', '/chat', { text }, { signal });
      if (!result.ok) {
        const err = new Error(result.error || 'Floki response failed');
        onError?.(err);
        throw err;
      }
      const reply = String(result.reply || '');
      onStateChange?.(FlokiState.RESPONDING);
      onToken?.(reply);
      const latency = this.latencyFromEvents(result.latency_events || []);
      onLatency?.(latency);
      onComplete?.(reply, latency);
      return result;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        onError?.(error);
      }
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async sendVoiceUtterance({ audioBlob, signal, onStateChange, onToken, onLatency, onError, onComplete }) {
    onStateChange?.(FlokiState.LISTENING);
    try {
      const result = hasBridge()
        ? await bridge().sendVoiceUtterance({
          base64: await blobToBase64(audioBlob),
          contentType: audioBlob.type || 'audio/wav',
        })
        : await runtimeHttpRequest('POST', '/audio/remote-utterance', null, {
          rawBody: audioBlob,
          contentType: audioBlob.type || 'audio/wav',
          signal,
        });
      if (!result.ok) {
        const err = new Error(result.error || 'Floki voice response failed');
        onError?.(err);
        throw err;
      }
      const reply = String(result.reply || '');
      onStateChange?.(FlokiState.RESPONDING);
      onToken?.(reply);
      const latency = this.latencyFromEvents(result.cognition?.latency_events || []);
      if (result.transcription) {
        latency.transcriptionTime = Number(result.transcription.elapsed_ms || 0);
      }
      onLatency?.(latency);
      onComplete?.(reply, latency);
      return {
        ...result,
        replyAudioBlob: result.reply_audio?.base64
          ? base64ToBlob(result.reply_audio.base64, result.reply_audio.content_type || 'audio/wav')
          : null,
      };
    } catch (error) {
      if (error?.name !== 'AbortError') onError?.(error);
      throw error;
    }
  }

  latencyFromEvents(events) {
    const byStage = new Map(events.map((event) => [event.stage, event]));
    const elapsed = (stage) => Number(byStage.get(stage)?.elapsed_ms || 0);
    return {
      transcriptionTime: 0,
      memoryContextTime: elapsed('memory_context_ready'),
      visionContextTime: elapsed('cached_vision_ready'),
      cognitionTime: elapsed('final_model_output'),
      timeToFirstToken: elapsed('first_chunk'),
      totalGenerationTime: elapsed('schema_valid'),
      textToSpeechTime: 0,
      totalResponseTime: elapsed('response_completed'),
    };
  }

  getLatencyHealth(ms) {
    if (ms < 1000) return 'Healthy';
    if (ms < 4000) return 'Slow';
    return 'Critical';
  }
  async getSelfImprovementStatus() {
    if (hasBridge()) return bridge().getSelfImprovementStatus();
    const result = await runtimeHttpRequest('GET', '/self-improvement/status');
    return result.status;
  }
  async getSelfImprovementCandidates() {
    if (hasBridge()) return bridge().getSelfImprovementCandidates();
    const result = await runtimeHttpRequest('GET', '/self-improvement/candidates');
    return result.candidates || [];
  }
  async getSelfImprovementCandidate(id) {
    if (hasBridge()) return bridge().getSelfImprovementCandidate(id);
    const result = await runtimeHttpRequest('GET', '/self-improvement/candidates/' + encodeURIComponent(String(id)));
    return result.candidate;
  }
  async approveSelfImprovement(id) {
    if (hasBridge()) return bridge().approveSelfImprovement(id);
    return runtimeHttpRequest('POST', '/self-improvement/approve', { id: String(id) });
  }
  async denySelfImprovement(id, reason = '') {
    if (hasBridge()) return bridge().denySelfImprovement(id, reason);
    return runtimeHttpRequest('POST', '/self-improvement/deny', { id: String(id), reason: String(reason) });
  }
  async pauseSelfImprovement() {
    if (hasBridge()) return bridge().pauseSelfImprovement();
    return runtimeHttpRequest('POST', '/self-improvement/pause', {});
  }
  async resumeSelfImprovement() {
    if (hasBridge()) return bridge().resumeSelfImprovement();
    return runtimeHttpRequest('POST', '/self-improvement/resume', {});
  }
  async runSelfImprovementNow(objective = '', kind = 'code') {
    if (hasBridge()) return bridge().runSelfImprovementNow(objective, kind);
    return runtimeHttpRequest('POST', '/self-improvement/run-now', { objective: String(objective), kind: String(kind) });
  }
  async abortSelfImprovement(kind = 'code', reason = '') {
    if (hasBridge()) return bridge().abortSelfImprovement(kind, reason);
    return runtimeHttpRequest('POST', '/self-improvement/abort', { kind: String(kind), reason: String(reason) });
  }
  async getSelfImprovementActivity(params = {}) {
    if (hasBridge()) return bridge().getSelfImprovementActivity(params);
    const q = new URLSearchParams();
    if (params.init) q.set('init', 'true');
    if (params.audit_cursor != null) q.set('audit_cursor', String(params.audit_cursor));
    if (params.sandbox_cursor != null) q.set('sandbox_cursor', String(params.sandbox_cursor));
    if (params.limit != null) q.set('limit', String(params.limit));
    return runtimeHttpRequest('GET', '/self-improvement/activity?' + q.toString(), null, {
      signal: params.signal
    });
  }
  async getSelfImprovementTerminal(params = {}) {
    if (hasBridge()) return bridge().getSelfImprovementTerminal ? bridge().getSelfImprovementTerminal(params) : null;
    const q = new URLSearchParams();
    if (params.cursor != null) q.set('cursor', String(params.cursor));
    if (params.max_bytes != null) q.set('max_bytes', String(params.max_bytes));
    return runtimeHttpRequest('GET', '/self-improvement/terminal?' + q.toString(), null, {
      signal: params.signal
    });
  }
}

export const flokiAdapter = new FlokiAdapter();
export default flokiAdapter;
