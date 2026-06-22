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
  async getTranscript(limit = 200) { return bridge().getTranscript(limit); }
  async clearTranscript() { return bridge().clearTranscript(); }
  async control(action, argument = null) { return bridge().control(action, argument); }
  async openLog(service) { return bridge().openLog(service); }
  async interruptResponse() { return bridge().interrupt(); }

  async sendMessage(text) {
    return bridge().sendMessage(text);
  }

  async sendChatMessage({ text, signal, onStateChange, onToken, onLatency, onError, onComplete }) {
    onStateChange?.(FlokiState.THINKING);
    const onAbort = () => { bridge().interrupt().catch(() => {}); };
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
}

export const flokiAdapter = new FlokiAdapter();
export default flokiAdapter;
