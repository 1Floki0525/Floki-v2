'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createVoiceOutputLock } = require('../chat/voice-output-lock.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'input', 'microphone-smoke');

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

function microphoneCaptureAllowed(env = process.env) {
  return env.FLOKI_ALLOW_MICROPHONE_CAPTURE === '1';
}

function microphoneCaptureGuardStatus(env = process.env) {
  const allowed = microphoneCaptureAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_MICROPHONE_CAPTURE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_MICROPHONE_CAPTURE=1',
    microphone_recorded_now: false,
    reason: allowed
      ? 'Microphone capture is explicitly allowed for this one proof run.'
      : 'Microphone capture is guarded. Run npm run proof:microphone-capture to allow one explicit short recording proof.'
  });
}

function microphoneVoiceLockStatus(options = {}) {
  const lock = createVoiceOutputLock({
    lock_file: options.voice_lock_file
  });

  const local = {};

  if (typeof options.voice_lock_now_ms === 'number') {
    local.now_ms = options.voice_lock_now_ms;
  }

  return lock.isEarsMuted(local);
}

function wavStatus(filePath) {
  try {
    const stat = fs.statSync(filePath);

    if (!stat.isFile() || stat.size <= 44) {
      return Object.freeze({
        ready: false,
        path: filePath,
        size_bytes: stat.size,
        riff_header: false,
        wave_header: false
      });
    }

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(12);
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    return Object.freeze({
      ready: true,
      path: filePath,
      size_bytes: stat.size,
      riff_header: buffer.slice(0, 4).toString('ascii') === 'RIFF',
      wave_header: buffer.slice(8, 12).toString('ascii') === 'WAVE'
    });
  } catch (_error) {
    return Object.freeze({
      ready: false,
      path: filePath,
      size_bytes: 0,
      riff_header: false,
      wave_header: false
    });
  }
}

function buildArecordArgs(options = {}) {
  const device = options.device || process.env.FLOKI_MIC_DEVICE || 'default';
  const seconds = Number(options.seconds || process.env.FLOKI_MIC_CAPTURE_SECONDS || 3);
  const rate = Number(options.rate || process.env.FLOKI_MIC_RATE || 16000);
  const channels = Number(options.channels || process.env.FLOKI_MIC_CHANNELS || 1);
  const format = options.format || process.env.FLOKI_MIC_FORMAT || 'S16_LE';
  const outputFile = options.output_file;

  if (!outputFile) {
    throw new Error('output_file is required');
  }

  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) {
    throw new Error('microphone capture seconds must be between 1 and 10');
  }

  if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) {
    throw new Error('microphone capture rate must be between 8000 and 96000');
  }

  if (!Number.isFinite(channels) || channels < 1 || channels > 2) {
    throw new Error('microphone capture channels must be 1 or 2');
  }

  const args = [
    '-q',
    '-D',
    device,
    '-f',
    format,
    '-r',
    String(rate),
    '-c',
    String(channels),
    '-d',
    String(seconds),
    '-t',
    'wav',
    outputFile
  ];

  return Object.freeze({
    args,
    device,
    seconds,
    rate,
    channels,
    format,
    output_file: outputFile
  });
}

function runMicrophoneCaptureProof(options = {}) {
  const guard = microphoneCaptureGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_MICROPHONE_CAPTURE_BLOCKED',
      guard,
      microphone_recorded_now: false,
      speaker_playback_run_now: false,
      whisper_transcription_run_now: false,
      yolo_inference_run_now: false,
      vad_audio_analysis_run_now: false,
      minecraft_called: false
    });
  }

  const ears = microphoneVoiceLockStatus(options);

  if (ears.ears_muted_now === true) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_MICROPHONE_CAPTURE_BLOCKED_BY_VOICE_LOCK',
      guard,
      ears,
      voice_output_lock_active: true,
      ears_muted_now: true,
      microphone_recorded_now: false,
      speaker_playback_run_now: false,
      whisper_transcription_run_now: false,
      yolo_inference_run_now: false,
      vad_audio_analysis_run_now: false,
      webcam_opened_now: false,
      minecraft_called: false,
      chat_mode_only: true
    });
  }

  const arecord = commandReady('arecord');

  if (!arecord.ready) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_MICROPHONE_CAPTURE_FAIL',
      reason: 'arecord command not found',
      arecord,
      microphone_recorded_now: false,
      speaker_playback_run_now: false,
      whisper_transcription_run_now: false,
      yolo_inference_run_now: false,
      vad_audio_analysis_run_now: false,
      minecraft_called: false
    });
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const outputId = 'microphone_smoke_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outputFile = options.output_file || path.join(OUTPUT_DIR, outputId + '.wav');
  const arecordPlan = buildArecordArgs({
    ...options,
    output_file: outputFile
  });

  const result = spawnSync('arecord', arecordPlan.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: (arecordPlan.seconds + 5) * 1000
  });

  const wav = wavStatus(outputFile);
  const ok = result.status === 0 &&
    wav.ready &&
    wav.riff_header &&
    wav.wave_header &&
    wav.size_bytes > 44;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_MICROPHONE_CAPTURE_PASS' : 'FLOKI_V2_MICROPHONE_CAPTURE_FAIL',
    guard,
    arecord_path: arecord.path,
    device: arecordPlan.device,
    seconds: arecordPlan.seconds,
    rate: arecordPlan.rate,
    channels: arecordPlan.channels,
    format: arecordPlan.format,
    output_file: outputFile,
    output_ready: wav.ready,
    output_size_bytes: wav.size_bytes,
    riff_header: wav.riff_header,
    wave_header: wav.wave_header,
    arecord_exit_status: result.status,
    arecord_stdout: String(result.stdout || '').trim().slice(0, 500),
    arecord_stderr: String(result.stderr || '').trim().slice(0, 500),
    microphone_recorded_now: ok,
    speaker_playback_run_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    webcam_opened_now: false,
    minecraft_called: false
  });
}

function printMicrophoneCaptureProof() {
  const status = runMicrophoneCaptureProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printMicrophoneCaptureProof();
}

module.exports = {
  ROOT,
  OUTPUT_DIR,
  commandReady,
  microphoneCaptureAllowed,
  microphoneCaptureGuardStatus,
  microphoneVoiceLockStatus,
  wavStatus,
  buildArecordArgs,
  runMicrophoneCaptureProof,
  printMicrophoneCaptureProof
};
