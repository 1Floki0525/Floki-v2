import { FlokiState } from './types';

function bridge() {
  if (!window.floki) throw new Error('Floki Electron bridge is unavailable');
  return window.floki;
}

class FlokiAdapter {
  async getSystemStatus() { return bridge().getSystemStatus(); }
  async getVisionFrame() { return bridge().getVisionFrame(); }
  async getLatestFrame() { return bridge().getLatestFrame(); }
  async getMjpegPort() { return bridge().getMjpegPort(); }
  async getMjpegUrl() {
    const port = await this.getMjpegPort();
    return port ? `http://127.0.0.1:${port}/live.mjpeg` : null;
  }
  async getObservation() { return bridge().getObservation(); }
  async getEmotion() { return bridge().getEmotion(); }
  async getAffectHistory(limit = 360) { return bridge().getAffectHistory(limit); }
  async getSleepStatus() { return bridge().getSleepStatus(); }
  async getNeuralEvents(limit = 250) { return bridge().getNeuralEvents(limit); }
  async getDreamTimeline() { return bridge().getDreamTimeline(); }
  async getInitialStatus() { return bridge().getInitialStatus(); }
  async getSettings() { return bridge().getSettings(); }
  async getTranscript(limit = 200) { return bridge().getTranscript(limit); }
  async clearTranscript() { return bridge().clearTranscript(); }
  async control(action, argument = null) { return bridge().control(action, argument); }
  async openLog(service) { return bridge().openLog(service); }
  async interruptResponse() { return bridge().interrupt(); }
  async setPushToTalk(active) { return bridge().setPushToTalk(active); }
  async subscribeRuntimeEvents(onEvent) {
    const [url, settings] = await Promise.all([
      bridge().getRuntimeWebSocketUrl(),
      bridge().getSettings(),
    ]);
    const autoReconnect = settings?.connection?.autoReconnect === true;
    const reconnectDelay = Number(settings?.connection?.reconnectDelay);
    if (!Number.isFinite(reconnectDelay) || reconnectDelay <= 0) {
      throw new Error('connection.reconnectDelay is missing from authoritative settings');
    }

    let stopped = false;
    let socket = null;
    let reconnectTimer = null;

    const scheduleReconnect = () => {
      if (stopped || !autoReconnect || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
    };

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(url);
      socket.addEventListener('open', () => {
        reconnectAttempts = 0;
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
    const onAbort = () => { bridge().interrupt().catch((error) => console.error('interrupt request failed', error)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await bridge().sendMessage(text);
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
  async getSelfImprovementStatus() { return bridge().getSelfImprovementStatus(); }
  async getSelfImprovementCandidates() { return bridge().getSelfImprovementCandidates(); }
  async getSelfImprovementCandidate(id) { return bridge().getSelfImprovementCandidate(id); }
  async approveSelfImprovement(id) { return bridge().approveSelfImprovement(id); }
  async denySelfImprovement(id, reason = '') { return bridge().denySelfImprovement(id, reason); }
  async pauseSelfImprovement() { return bridge().pauseSelfImprovement(); }
  async resumeSelfImprovement() { return bridge().resumeSelfImprovement(); }
  async runSelfImprovementNow(objective = '') { return bridge().runSelfImprovementNow(objective); }
  async getSelfImprovementActivity(params = {}) { return bridge().getSelfImprovementActivity(params); }
}

export const flokiAdapter = new FlokiAdapter();
export default flokiAdapter;
