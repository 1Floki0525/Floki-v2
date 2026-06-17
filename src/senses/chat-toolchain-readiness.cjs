'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const VENV_DIR = path.join(TOOLS_DIR, 'venv-chat-embodiment');
const PYTHON = path.join(VENV_DIR, 'bin', 'python');
const PIPER_CLI = path.join(VENV_DIR, 'bin', 'piper');
const WHISPER_CLI = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL_DIR = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'models');
const YOLO_MODEL = path.join(TOOLS_DIR, 'models', 'yolo', 'yolo11n.pt');
const PIPER_VOICE_DIR = path.join(TOOLS_DIR, 'models', 'piper', 'voices');

function exists(filePath) {
  return fs.existsSync(filePath);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function fileReady(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

function runPythonImport(moduleName, importCode) {
  if (!isExecutable(PYTHON)) {
    return Object.freeze({
      ok: false,
      module: moduleName,
      reason: 'python venv is missing'
    });
  }

  const yoloConfigDir = path.join(TOOLS_DIR, 'yolo-config');
  fs.mkdirSync(yoloConfigDir, { recursive: true });

  const result = spawnSync(PYTHON, ['-c', importCode], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      YOLO_CONFIG_DIR: yoloConfigDir
    }
  });

  return Object.freeze({
    ok: result.status === 0,
    module: moduleName,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim().slice(0, 500)
  });
}

function piperVoice(size, name) {
  const model = path.join(PIPER_VOICE_DIR, size, name + '.onnx');
  const config = path.join(PIPER_VOICE_DIR, size, name + '.onnx.json');

  return Object.freeze({
    size,
    name,
    model_path: model,
    config_path: config,
    model_ready: fileReady(model),
    config_ready: fileReady(config),
    ready: fileReady(model) && fileReady(config)
  });
}

function buildChatToolchainReadinessStatus() {
  const silero = runPythonImport('silero_vad', "import silero_vad; print('SILERO_VAD_IMPORT_OK')");
  const ultralytics = runPythonImport('ultralytics', "from ultralytics import YOLO; print('ULTRALYTICS_IMPORT_OK')");

  const whisper = Object.freeze({
    cli_path: WHISPER_CLI,
    cli_ready: isExecutable(WHISPER_CLI),
    tiny_en_model_path: path.join(WHISPER_MODEL_DIR, 'ggml-tiny.en.bin'),
    small_en_model_path: path.join(WHISPER_MODEL_DIR, 'ggml-small.en.bin'),
    tiny_en_model_ready: fileReady(path.join(WHISPER_MODEL_DIR, 'ggml-tiny.en.bin')),
    small_en_model_ready: fileReady(path.join(WHISPER_MODEL_DIR, 'ggml-small.en.bin'))
  });

  const piper = Object.freeze({
    cli_path: PIPER_CLI,
    cli_ready: isExecutable(PIPER_CLI),
    voices_dir: PIPER_VOICE_DIR,
    voices: Object.freeze({
      tiny: piperVoice('tiny', 'en_US-amy-low'),
      small: piperVoice('small', 'en_US-amy-medium'),
      med: piperVoice('med', 'en_US-lessac-medium'),
      large: piperVoice('large', 'en_US-ryan-high')
    })
  });

  const yolo = Object.freeze({
    package_import_ready: ultralytics.ok,
    model_path: YOLO_MODEL,
    model_ready: fileReady(YOLO_MODEL)
  });

  const vad = Object.freeze({
    package_import_ready: silero.ok
  });

  const allPiperVoicesReady = piper.voices.tiny.ready &&
    piper.voices.small.ready &&
    piper.voices.med.ready &&
    piper.voices.large.ready;

  const ok = whisper.cli_ready &&
    whisper.tiny_en_model_ready &&
    whisper.small_en_model_ready &&
    isExecutable(PYTHON) &&
    piper.cli_ready &&
    allPiperVoicesReady &&
    vad.package_import_ready &&
    yolo.package_import_ready &&
    yolo.model_ready;

  return Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_PASS' : 'FLOKI_V2_CHAT_TOOLCHAIN_READINESS_FAIL',
    tools_dir: TOOLS_DIR,
    python_venv_ready: isExecutable(PYTHON),
    whisper,
    piper,
    vad,
    yolo,
    runtime_capture_enabled_now: false,
    webcam_opened_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    vad_audio_analysis_run_now: false,
    piper_speech_run_now: false,
    minecraft_called: false
  });
}

function printChatToolchainReadinessStatus() {
  const status = buildChatToolchainReadinessStatus();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatToolchainReadinessStatus();
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  VENV_DIR,
  PYTHON,
  PIPER_CLI,
  WHISPER_CLI,
  YOLO_MODEL,
  PIPER_VOICE_DIR,
  buildChatToolchainReadinessStatus,
  printChatToolchainReadinessStatus
};
