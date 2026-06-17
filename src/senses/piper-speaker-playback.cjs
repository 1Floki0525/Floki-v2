'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const {
  synthesizePiperSpeechToFile
} = require('./piper-speech-smoke.cjs');

function playbackAllowed(env = process.env) {
  return env.FLOKI_ALLOW_SPEAKER_PLAYBACK === '1';
}

function speakerPlaybackGuardStatus(env = process.env) {
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_GUARDED',
    allowed_now: playbackAllowed(env),
    required_env: 'FLOKI_ALLOW_SPEAKER_PLAYBACK=1',
    speaker_playback_run_now: false
  });
}

function commandReady(command) {
  const result = spawnSync('bash', ['-lc', 'command -v ' + command], {
    encoding: 'utf8',
    timeout: 5000
  });

  return Object.freeze({
    ready: result.status === 0,
    command,
    path: String(result.stdout || '').trim()
  });
}

function playWavWithAplay(filePath) {
  const aplay = commandReady('aplay');

  if (!aplay.ready) {
    return Object.freeze({
      ok: false,
      command: 'aplay',
      reason: 'aplay command not found',
      exit_status: null
    });
  }

  const result = spawnSync('aplay', [filePath], {
    encoding: 'utf8',
    timeout: 60000
  });

  return Object.freeze({
    ok: result.status === 0,
    command: 'aplay',
    command_path: aplay.path,
    exit_status: result.status,
    stdout: String(result.stdout || '').trim().slice(0, 500),
    stderr: String(result.stderr || '').trim().slice(0, 500)
  });
}

function runPiperSpeakerPlaybackProof(options = {}) {
  const guard = speakerPlaybackGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_BLOCKED',
      guard,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const speech = synthesizePiperSpeechToFile({
    voice_size: options.voice_size || 'large',
    text: options.text || 'I am Floki. This is my first guarded speaker playback proof with a male US English voice.'
  });

  if (!speech.ok || !fs.existsSync(speech.output_file)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_FAIL',
      reason: 'speech synthesis failed before speaker playback',
      speech,
      piper_speech_run_now: true,
      speaker_playback_run_now: false,
      webcam_opened_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const playback = playWavWithAplay(speech.output_file);
  const ok = playback.ok === true;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_PASS' : 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_FAIL',
    guard,
    speech_output_file: speech.output_file,
    speech_output_size_bytes: speech.output_size_bytes,
    voice_size: speech.voice_size,
    voice_name: speech.voice_name,
    playback,
    piper_speech_run_now: true,
    speaker_playback_run_now: ok,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    minecraft_called: false
  });
}

function printPiperSpeakerPlaybackProof() {
  const status = runPiperSpeakerPlaybackProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printPiperSpeakerPlaybackProof();
}

module.exports = {
  playbackAllowed,
  speakerPlaybackGuardStatus,
  commandReady,
  playWavWithAplay,
  runPiperSpeakerPlaybackProof,
  printPiperSpeakerPlaybackProof
};
