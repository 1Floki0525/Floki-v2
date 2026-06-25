'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROJECT_ROOT: ROOT,
  getAudioConfig,
  getWakeGateConfig,
  getLiveChatConfig
} = require('../src/config/floki-config.cjs');
const { createLiveAudioService } = require('../src/senses/live-audio-service.cjs');

function frameFor(audio, amplitude) {
  const samples = Number(audio.vad_frame_samples);
  const channels = Number(audio.mic_channels);
  const frame = Buffer.alloc(samples * channels * 2);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(amplitude, offset);
  return frame;
}

function fakeRecorder(initialFrame) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = process.pid;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    process.nextTick(() => child.emit('close', 0, signal));
  };
  process.nextTick(() => {
    if (!child.killed) child.stdout.emit('data', initialFrame);
  });
  return child;
}

function fakeWhisper(transcripts) {
  let index = 0;
  const service = {
    status: () => ({ ready: true, backend: 'behavioral-test' }),
    start: async () => service.status(),
    stop: async () => service.status(),
    transcribe: async () => {
      const text = transcripts[Math.min(index, transcripts.length - 1)];
      index += 1;
      return { raw_text: text, speech_text: text, ambient_labels: [] };
    }
  };
  return service;
}

function fakePiper() {
  let callback = null;
  let speaking = false;
  const service = {
    status: () => ({ ready: true, playback_ready: true, speaking }),
    refreshReadiness: () => service.status(),
    setOnSpeakingChange: (fn) => { callback = fn; },
    speak: async (text, metadata) => {
      speaking = true;
      await callback(true);
      speaking = false;
      await callback(false);
      return { ok: true, text, metadata };
    },
    interrupt: () => ({ ok: true, interrupted: false })
  };
  return service;
}

async function waitUntil(predicate, timeoutMs, pollMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('timed out waiting for ' + label);
}

function feedFinalizedUtterance(service, audio, speechFrame, silenceFrame) {
  const sampleRate = Number(audio.mic_rate);
  const frameMs = Number(audio.vad_frame_samples) / sampleRate * 1000;
  const postRollFrames = Math.max(0, Math.ceil(Number(audio.post_roll_ms) / frameMs));
  for (let index = 0; index < Number(audio.vad_start_frames); index += 1) {
    service.injectVadProbability(speechFrame, 1);
  }
  service.injectVadProbability(speechFrame, 1);
  for (let index = 0; index < Number(audio.vad_end_frames) + postRollFrames + 1; index += 1) {
    service.injectVadProbability(silenceFrame, 0);
  }
}

async function run() {
  assert.equal(process.version.startsWith('v24.'), true, 'Node 24 is required');
  const audio = getAudioConfig('chat');
  const wake = getWakeGateConfig('chat');
  const live = getLiveChatConfig('chat');
  const runtimeDir = path.join(ROOT, 'state/floki/test/live-audio-behavioral-' + process.pid);
  fs.rmSync(runtimeDir, { recursive: true, force: true });

  const speechFrame = frameFor(audio, 1200);
  const silenceFrame = frameFor(audio, 0);
  const calls = [];
  const service = createLiveAudioService({
    runtime_dir: runtimeDir,
    voice_lock_file: path.join(runtimeDir, 'voice-output-lock.json'),
    initial_awake: true,
    audio_config: audio,
    deps: {
      whisper: fakeWhisper([wake.required_phrase, 'what can you see?']),
      piper: fakePiper(),
      disable_vad_worker: true,
      recorder_factory: () => fakeRecorder(speechFrame)
    },
    on_direct_speech: async (payload) => {
      calls.push(payload);
      return { reply: '' };
    }
  });

  await service.start();
  await waitUntil(() => service.status().microphone_open === true, live.runtime_start_timeout_ms, live.runtime_start_poll_ms, 'microphone open');

  feedFinalizedUtterance(service, audio, speechFrame, silenceFrame);
  await waitUntil(() => service.status().utterances_completed >= 1, live.runtime_start_timeout_ms, live.runtime_start_poll_ms, 'wake utterance transcription');
  assert.equal(calls.length, 0, 'wake phrase alone must not be sent to cognition');
  assert.equal(service.status().pending_wake_command, true, 'wake phrase must hold the command window open');
  assert.equal(service.status().microphone_open, true, 'microphone must remain open while waiting for the command');

  feedFinalizedUtterance(service, audio, speechFrame, silenceFrame);
  await waitUntil(() => calls.length === 1, live.runtime_start_timeout_ms, live.runtime_start_poll_ms, 'continued command routing');
  assert.equal(calls[0].request_text, 'what can you see?');
  assert.equal(calls[0].raw_text.toLowerCase(), wake.required_phrase.toLowerCase() + ', what can you see?');
  assert.equal(service.status().pending_wake_command, false);

  await service.speak('microphone lifecycle proof');
  assert.equal(service.status().speaking, false);
  assert.equal(service.status().microphone_open, true, 'microphone must reopen after Piper finishes');
  assert.equal(service.status().last_error, null);

  await service.stop();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_AUDIO_BEHAVIORAL_CONTRACT_PASS',
    two_finalized_utterances_joined: true,
    wake_phrase_alone_not_routed: true,
    microphone_open_while_waiting: true,
    microphone_reopened_after_speech_with_fresh_pcm: true,
    chat_mode_only: true
  }, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_AUDIO_BEHAVIORAL_CONTRACT_FAIL', error: error.stack || error.message }, null, 2));
  process.exit(1);
});
