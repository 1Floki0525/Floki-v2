'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PIPER_CLI,
  PIPER_VOICE_DIR,
  buildChatToolchainReadinessStatus
} = require('./chat-toolchain-readiness.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const OUTPUT_DIR = path.join(ROOT, '.floki-tools', 'output', 'piper-smoke');

const VOICES = Object.freeze({
  tiny: Object.freeze({
    size: 'tiny',
    name: 'en_US-amy-low',
    model: path.join(PIPER_VOICE_DIR, 'tiny', 'en_US-amy-low.onnx'),
    config: path.join(PIPER_VOICE_DIR, 'tiny', 'en_US-amy-low.onnx.json')
  }),
  small: Object.freeze({
    size: 'small',
    name: 'en_US-amy-medium',
    model: path.join(PIPER_VOICE_DIR, 'small', 'en_US-amy-medium.onnx'),
    config: path.join(PIPER_VOICE_DIR, 'small', 'en_US-amy-medium.onnx.json')
  }),
  med: Object.freeze({
    size: 'med',
    name: 'en_US-lessac-medium',
    model: path.join(PIPER_VOICE_DIR, 'med', 'en_US-lessac-medium.onnx'),
    config: path.join(PIPER_VOICE_DIR, 'med', 'en_US-lessac-medium.onnx.json')
  }),
  large: Object.freeze({
    size: 'large',
    name: 'en_US-ryan-high',
    model: path.join(PIPER_VOICE_DIR, 'large', 'en_US-ryan-high.onnx'),
    config: path.join(PIPER_VOICE_DIR, 'large', 'en_US-ryan-high.onnx.json')
  })
});

function fileReady(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function executableReady(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function safeSpeechText(text) {
  const value = String(text || '').trim();

  if (!value) {
    throw new Error('speech text cannot be empty');
  }

  if (value.length > 240) {
    throw new Error('speech text too long for smoke proof');
  }

  return value;
}

function wavStatus(filePath) {
  if (!fileReady(filePath)) {
    return Object.freeze({
      ready: false,
      path: filePath,
      size_bytes: 0,
      riff_header: false,
      wave_header: false
    });
  }

  const stat = fs.statSync(filePath);
  const header = fs.readFileSync(filePath, { start: 0, end: 11 });

  return Object.freeze({
    ready: true,
    path: filePath,
    size_bytes: stat.size,
    riff_header: header.slice(0, 4).toString('ascii') === 'RIFF',
    wave_header: header.slice(8, 12).toString('ascii') === 'WAVE'
  });
}

function synthesizePiperSpeechToFile(options = {}) {
  const readiness = buildChatToolchainReadinessStatus();

  if (!readiness.ok) {
    throw new Error('chat toolchain readiness is not passing');
  }

  if (!executableReady(PIPER_CLI)) {
    throw new Error('Piper CLI is not executable: ' + PIPER_CLI);
  }

  const voiceSize = options.voice_size || 'small';
  const voice = VOICES[voiceSize];

  if (!voice) {
    throw new Error('unsupported Piper voice size: ' + voiceSize);
  }

  if (!fileReady(voice.model)) {
    throw new Error('Piper voice model missing: ' + voice.model);
  }

  if (!fileReady(voice.config)) {
    throw new Error('Piper voice config missing: ' + voice.config);
  }

  const text = safeSpeechText(options.text || 'I am Floki. My voice is waking up safely, one proof at a time.');
  const outputId = 'piper_smoke_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outputFile = options.output_file || path.join(OUTPUT_DIR, outputId + '_' + voiceSize + '.wav');

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const result = spawnSync(PIPER_CLI, [
    '--model',
    voice.model,
    '--output_file',
    outputFile
  ], {
    cwd: ROOT,
    input: text + '\n',
    encoding: 'utf8',
    timeout: 60000
  });

  const wav = wavStatus(outputFile);
  const ok = result.status === 0 &&
    wav.ready &&
    wav.riff_header &&
    wav.wave_header &&
    wav.size_bytes > 44;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_PIPER_SPEECH_SMOKE_PASS' : 'FLOKI_V2_PIPER_SPEECH_SMOKE_FAIL',
    voice_size: voiceSize,
    voice_name: voice.name,
    piper_cli: PIPER_CLI,
    model_path: voice.model,
    config_path: voice.config,
    output_file: outputFile,
    output_ready: wav.ready,
    output_size_bytes: wav.size_bytes,
    riff_header: wav.riff_header,
    wave_header: wav.wave_header,
    piper_exit_status: result.status,
    piper_stdout: String(result.stdout || '').trim().slice(0, 500),
    piper_stderr: String(result.stderr || '').trim().slice(0, 500),
    text_length: text.length,
    piper_speech_run_now: true,
    speaker_playback_run_now: false,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    minecraft_called: false
  });
}

function printPiperSpeechSmokeStatus() {
  const status = synthesizePiperSpeechToFile();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printPiperSpeechSmokeStatus();
}

module.exports = {
  OUTPUT_DIR,
  VOICES,
  fileReady,
  executableReady,
  safeSpeechText,
  wavStatus,
  synthesizePiperSpeechToFile,
  printPiperSpeechSmokeStatus
};
