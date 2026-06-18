'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  synthesizePiperSpeechToFile
} = require('./piper-speech-smoke.cjs');

const {
  createVoiceOutputLock
} = require('../chat/voice-output-lock.cjs');

const { getTimeoutConfig } = require('../config/floki-config.cjs');

function playbackAllowed(env = process.env) {
  return env.FLOKI_ALLOW_SPEAKER_PLAYBACK === '1';
}

function speakerPlaybackGuardStatus(env = process.env) {
  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_GUARDED',
    allowed_now: playbackAllowed(env),
    required_env: 'FLOKI_ALLOW_SPEAKER_PLAYBACK=1',
    speaker_playback_run_now: false,
    voice_output_lock_required: true,
    ears_muted_during_playback: false
  });
}

function commandReady(command) {
  const result = spawnSync('bash', ['-lc', 'command -v ' + command], {
    encoding: 'utf8',
    timeout: getTimeoutConfig('chat').command_check_ms
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
    timeout: getTimeoutConfig('chat').speaker_playback_ms
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

function runPlaybackWithVoiceLock(filePath, metadata = {}, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('speaker playback requires a wav file path');
  }

  const lock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  });

  const playbackRunner = options.playback_runner || playWavWithAplay;
  const startNow = typeof options.voice_lock_start_now_ms === 'number'
    ? options.voice_lock_start_now_ms
    : undefined;
  const endNow = typeof options.voice_lock_end_now_ms === 'number'
    ? options.voice_lock_end_now_ms
    : undefined;

  const started = lock.beginSpeaking({
    source: 'speaker_playback',
    output_id: metadata.output_id || filePath,
    text_hash: metadata.text_hash || path.basename(filePath),
    ttl_ms: Number(options.voice_lock_ttl_ms || 120000),
    now_ms: startNow
  });

  if (started.ears_muted_now !== true) {
    lock.endSpeaking({
      reason: 'lock_failed_before_playback',
      now_ms: endNow
    });

    throw new Error('voice output lock did not mute ears before speaker playback');
  }

  let playback;
  let playbackError = null;

  try {
    playback = playbackRunner(filePath);
  } catch (error) {
    playbackError = error;
    playback = Object.freeze({
      ok: false,
      command: 'playback_runner',
      reason: error.message
    });
  } finally {
    const ended = lock.endSpeaking({
      reason: playback && playback.ok === true ? 'completed' : 'playback_failed',
      now_ms: endNow
    });

    const ok = playback &&
      playback.ok === true &&
      started.ears_muted_now === true &&
      ended.ears_muted_now === false &&
      ended.speaking_now === false;

    const status = Object.freeze({
      ok,
      marker: ok
        ? 'FLOKI_V2_SPEAKER_PLAYBACK_WITH_VOICE_LOCK_PASS'
        : 'FLOKI_V2_SPEAKER_PLAYBACK_WITH_VOICE_LOCK_FAIL',
      file_path: filePath,
      playback,
      playback_error_message: playbackError ? playbackError.message : null,
      lock_file: lock.lock_file,
      voice_output_lock_started: true,
      voice_output_lock_start_reason: started.reason,
      voice_output_lock_id: started.lock_id,
      ears_muted_during_playback: started.ears_muted_now === true,
      voice_output_lock_cleared_after_playback: ended.ears_muted_now === false && ended.speaking_now === false,
      ears_open_after_playback: ended.ears_muted_now === false,
      started,
      ended,
      speaker_playback_run_now: playback ? playback.ok === true : false,
      chat_mode_only: true
    });

    return status;
  }
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
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      webcam_opened_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const synthesizer = options.piper_synthesizer || synthesizePiperSpeechToFile;

  const speech = synthesizer({
    voice_size: options.voice_size || 'large',
    text: options.text || 'I am Floki. This is my first guarded speaker playback proof with a male US English voice.',
    output_dir: options.output_dir
  });

  if (!speech.ok || !fs.existsSync(speech.output_file)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_FAIL',
      reason: 'speech synthesis failed before speaker playback',
      speech,
      piper_speech_run_now: true,
      speaker_playback_run_now: false,
      voice_output_lock_started: false,
      ears_muted_during_playback: false,
      voice_output_lock_cleared_after_playback: false,
      webcam_opened_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const lockedPlayback = runPlaybackWithVoiceLock(speech.output_file, {
    output_id: speech.output_file,
    text_hash: 'piper_speaker_playback_' + String(speech.output_size_bytes || 0)
  }, {
    voice_lock_file: options.voice_lock_file,
    voice_lock_start_now_ms: options.voice_lock_start_now_ms,
    voice_lock_end_now_ms: options.voice_lock_end_now_ms,
    voice_lock_ttl_ms: options.voice_lock_ttl_ms,
    playback_runner: options.playback_runner
  });

  const ok = lockedPlayback.ok === true;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_PASS' : 'FLOKI_V2_PIPER_SPEAKER_PLAYBACK_FAIL',
    guard,
    speech_output_file: speech.output_file,
    speech_output_size_bytes: speech.output_size_bytes,
    voice_size: speech.voice_size,
    voice_name: speech.voice_name,
    playback: lockedPlayback.playback,
    locked_playback: lockedPlayback,
    voice_output_lock_started: lockedPlayback.voice_output_lock_started === true,
    ears_muted_during_playback: lockedPlayback.ears_muted_during_playback === true,
    voice_output_lock_cleared_after_playback: lockedPlayback.voice_output_lock_cleared_after_playback === true,
    ears_open_after_playback: lockedPlayback.ears_open_after_playback === true,
    piper_speech_run_now: true,
    speaker_playback_run_now: ok,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    minecraft_called: false,
    chat_mode_only: true
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
  runPlaybackWithVoiceLock,
  runPiperSpeakerPlaybackProof,
  printPiperSpeakerPlaybackProof
};
