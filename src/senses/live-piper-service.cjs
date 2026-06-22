'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT, getAudioConfig, getTimeoutConfig } = require('../config/floki-config.cjs');
const { PIPER_CLI, PIPER_VOICE_DIR } = require('./chat-toolchain-readiness.cjs');
const { runPlaybackWithVoiceLockAsync } = require('./piper-speaker-playback.cjs');
const { nowIso } = require('../util/time.cjs');
const { newId } = require('../util/ids.cjs');

function selectedVoice(audio) {
  const size = String(audio.piper_voice_size || '').trim().toLowerCase();
  const name = String(audio.piper_voice_name || '').trim();
  if (!size) throw new Error('audio.piper_voice_size must be configured in YAML');
  if (!name) throw new Error('audio.piper_voice_name must be configured in YAML');
  return Object.freeze({
    size,
    name,
    model: path.join(PIPER_VOICE_DIR, size, name + '.onnx'),
    config: path.join(PIPER_VOICE_DIR, size, name + '.onnx.json')
  });
}


function executable(filePath) {
  try { fs.accessSync(filePath, fs.constants.X_OK); return true; } catch (_error) { return false; }
}

function fileReady(filePath) {
  try { const stat = fs.statSync(filePath); return stat.isFile() && stat.size > 0; } catch (_error) { return false; }
}

function commandPath(command) {
  const result = spawnSync('bash', ['-lc', 'command -v ' + command], { encoding: 'utf8', timeout: getTimeoutConfig('chat').command_check_ms });
  return result.status === 0 ? String(result.stdout || '').trim() || null : null;
}

function createLivePiperService(options = {}) {
  const audio = options.audio_config || getAudioConfig('chat');
  const outputDir = options.output_dir || path.join(ROOT, 'state', 'floki', 'chat', 'runtime', 'audio-tmp');
  const voice = selectedVoice(audio);
  const aplay = commandPath('aplay');
  const state = {
    ready: false,
    speaking: false,
    piper_cli_ready: false,
    voice_model_ready: false,
    voice_config_ready: false,
    playback_ready: false,
    voice_size: voice.size,
    voice_name: voice.name,
    last_error: null,
    last_speech_started_at: null,
    last_first_audio_at: null,
    last_speech_completed_at: null,
    utterances_spoken: 0
  };

  function refreshReadiness() {
    state.piper_cli_ready = executable(PIPER_CLI);
    state.voice_model_ready = fileReady(voice.model);
    state.voice_config_ready = fileReady(voice.config);
    state.playback_ready = Boolean(aplay);
    state.ready = state.piper_cli_ready && state.voice_model_ready && state.voice_config_ready && state.playback_ready;
    return status();
  }

  function status() {
    return Object.freeze({
      marker: 'FLOKI_V2_LIVE_PIPER_STATUS',
      ...state,
      piper_cli: PIPER_CLI,
      voice_model: voice.model,
      voice_config: voice.config,
      playback_command: aplay
    });
  }

  async function synthesize(text, metadata = {}) {
    refreshReadiness();
    if (!state.ready) throw new Error('Piper is not ready: ' + JSON.stringify(status()));
    const safe = String(text || '').trim();
    if (!safe) throw new Error('speech text cannot be empty');
    if (safe.length > 4000) throw new Error('speech text exceeds live Piper limit');
    fs.mkdirSync(outputDir, { recursive: true });
    const id = metadata.utterance_id || newId('speech');
    const outputFile = path.join(outputDir, id + '.wav');
    fs.rmSync(outputFile, { force: true });

    return new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      const child = spawn(PIPER_CLI, ['--model', voice.model, '--config', voice.config, '--output_file', outputFile], {
        cwd: ROOT,
        stdio: ['pipe', 'ignore', 'pipe']
      });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Piper synthesis timed out'));
      }, Number(getTimeoutConfig('chat').piper_synthesis_ms || 60000));
      child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0 || !fileReady(outputFile)) {
          reject(new Error('Piper synthesis failed (' + String(code) + '/' + String(signal || '') + '): ' + stderr.trim().slice(0, 800)));
          return;
        }
        resolve(Object.freeze({ ok: true, output_file: outputFile, voice_size: voice.size, voice_name: voice.name }));
      });
      child.stdin.on('error', (error) => {
        if (!settled && error.code !== 'EPIPE') state.last_error = error.message;
      });
      child.stdin.end(safe + '\n');
    });
  }

  async function speak(text, metadata = {}) {
    if (state.speaking) throw new Error('Piper is already speaking');
    state.speaking = true;
    state.last_error = null;
    state.last_speech_started_at = nowIso();
    if (typeof options.on_speaking_change === 'function') await options.on_speaking_change(true);
    let synthesis = null;
    try {
      synthesis = await synthesize(text, metadata);
      state.last_first_audio_at = nowIso();
      const playback = await runPlaybackWithVoiceLockAsync(synthesis.output_file, {
        output_id: metadata.utterance_id || synthesis.output_file,
        text_hash: metadata.text_hash || 'live_piper_' + String(text.length)
      }, {
        voice_lock_ttl_ms: audio.voice_lock_ttl_ms
      });
      if (!playback || playback.ok !== true) throw new Error('Piper playback failed');
      state.utterances_spoken += 1;
      state.last_speech_completed_at = nowIso();
      return Object.freeze({ ok: true, synthesis, playback, first_audio_at: state.last_first_audio_at });
    } catch (error) {
      state.last_error = error.message;
      throw error;
    } finally {
      if (synthesis && synthesis.output_file) fs.rmSync(synthesis.output_file, { force: true });
      state.speaking = false;
      if (typeof options.on_speaking_change === 'function') await options.on_speaking_change(false);
    }
  }

  refreshReadiness();
  return Object.freeze({ status, refreshReadiness, synthesize, speak });
}

module.exports = {
  ROOT,
  selectedVoice,
  createLivePiperService
};
