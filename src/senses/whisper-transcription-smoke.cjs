'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const WHISPER_CLI = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL_DIR = path.join(TOOLS_DIR, 'repos', 'whisper.cpp', 'models');
const MICROPHONE_INPUT_DIR = path.join(TOOLS_DIR, 'input', 'microphone-smoke');
const WHISPER_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'whisper-smoke');

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

function whisperTranscriptionAllowed(env = process.env) {
  return env.FLOKI_ALLOW_WHISPER_TRANSCRIPTION === '1';
}

function whisperGuardStatus(env = process.env) {
  const allowed = whisperTranscriptionAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_WHISPER_TRANSCRIPTION=1',
    whisper_transcription_run_now: false,
    reason: allowed
      ? 'Whisper transcription is explicitly allowed for this one proof run.'
      : 'Whisper transcription is guarded. Run npm run proof:whisper-transcription to transcribe the latest microphone WAV.'
  });
}

function latestMicrophoneWav() {
  try {
    const files = fs.readdirSync(MICROPHONE_INPUT_DIR)
      .filter((name) => name.endsWith('.wav'))
      .map((name) => path.join(MICROPHONE_INPUT_DIR, name))
      .filter(fileReady)
      .map((filePath) => {
        const stat = fs.statSync(filePath);
        return {
          file_path: filePath,
          mtime_ms: stat.mtimeMs,
          size_bytes: stat.size
        };
      })
      .sort((a, b) => b.mtime_ms - a.mtime_ms);

    return files[0] || null;
  } catch (_error) {
    return null;
  }
}

function whisperModelPath(modelSize) {
  const normalized = String(modelSize || 'small').trim();

  if (normalized === 'tiny') {
    return path.join(WHISPER_MODEL_DIR, 'ggml-tiny.en.bin');
  }

  if (normalized === 'small') {
    return path.join(WHISPER_MODEL_DIR, 'ggml-small.en.bin');
  }

  throw new Error('unsupported Whisper model size: ' + normalized);
}

function cleanTranscriptionText(text) {
  return String(text || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]*music[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textLooksLikeSpeech(text) {
  return /[A-Za-z]{2,}/.test(String(text || ''));
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function runWhisperTxtAttempt(inputFile, modelFile, outputBase) {
  const outputTxt = outputBase + '.txt';

  try {
    fs.rmSync(outputTxt, { force: true });
  } catch (_error) {
    // Ignore cleanup failure.
  }

  const args = [
    '-m',
    modelFile,
    '-f',
    inputFile,
    '-l',
    'en',
    '-otxt',
    '-of',
    outputBase,
    '-nt'
  ];

  const result = spawnSync(WHISPER_CLI, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });

  const fileText = readTextFile(outputTxt);
  const cleaned = cleanTranscriptionText(fileText);

  return Object.freeze({
    name: 'txt_file_attempt',
    ok: result.status === 0 && textLooksLikeSpeech(cleaned),
    args,
    output_txt: outputTxt,
    raw_text: fileText,
    transcription_text: cleaned,
    exit_status: result.status,
    stdout: String(result.stdout || '').trim().slice(0, 2000),
    stderr: String(result.stderr || '').trim().slice(0, 1000)
  });
}

function runWhisperStdoutAttempt(inputFile, modelFile) {
  const args = [
    '-m',
    modelFile,
    '-f',
    inputFile,
    '-l',
    'en',
    '-nt'
  ];

  const result = spawnSync(WHISPER_CLI, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });

  const stdout = String(result.stdout || '');
  const cleaned = cleanTranscriptionText(stdout);

  return Object.freeze({
    name: 'stdout_attempt',
    ok: result.status === 0 && textLooksLikeSpeech(cleaned),
    args,
    raw_text: stdout,
    transcription_text: cleaned,
    exit_status: result.status,
    stdout: stdout.trim().slice(0, 2000),
    stderr: String(result.stderr || '').trim().slice(0, 1000)
  });
}

function writeWhisperReport(status) {
  fs.mkdirSync(WHISPER_OUTPUT_DIR, { recursive: true });
  const reportFile = path.join(WHISPER_OUTPUT_DIR, 'latest-whisper-transcription.json');
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
}

function runWhisperTranscriptionProof(options = {}) {
  const guard = whisperGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_BLOCKED',
      guard,
      whisper_transcription_run_now: false,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      yolo_inference_run_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      minecraft_called: false
    });
  }

  if (!executableReady(WHISPER_CLI)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_FAIL',
      reason: 'whisper-cli is not executable',
      whisper_cli: WHISPER_CLI,
      whisper_transcription_run_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const modelSize = options.model_size || process.env.FLOKI_WHISPER_MODEL_SIZE || 'small';
  const modelFile = whisperModelPath(modelSize);

  if (!fileReady(modelFile)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_FAIL',
      reason: 'Whisper model file is missing',
      model_size: modelSize,
      model_file: modelFile,
      whisper_transcription_run_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const chosenInput = options.input_file || process.env.FLOKI_WHISPER_INPUT || null;
  const latest = chosenInput
    ? { file_path: chosenInput, size_bytes: fileReady(chosenInput) ? fs.statSync(chosenInput).size : 0 }
    : latestMicrophoneWav();

  if (!latest || !fileReady(latest.file_path)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_WHISPER_TRANSCRIPTION_FAIL',
      reason: 'No microphone WAV ready. Run npm run proof:microphone-capture first.',
      microphone_input_dir: MICROPHONE_INPUT_DIR,
      whisper_transcription_run_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  fs.mkdirSync(WHISPER_OUTPUT_DIR, { recursive: true });

  const outputId = 'whisper_smoke_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const outputBase = path.join(WHISPER_OUTPUT_DIR, outputId);

  const firstAttempt = runWhisperTxtAttempt(latest.file_path, modelFile, outputBase);
  const chosenAttempt = firstAttempt.ok
    ? firstAttempt
    : runWhisperStdoutAttempt(latest.file_path, modelFile);

  const text = cleanTranscriptionText(chosenAttempt.transcription_text);
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const ok = chosenAttempt.ok && textLooksLikeSpeech(text);

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_WHISPER_TRANSCRIPTION_PASS' : 'FLOKI_V2_WHISPER_TRANSCRIPTION_FAIL',
    input_file: latest.file_path,
    input_size_bytes: latest.size_bytes,
    whisper_cli: WHISPER_CLI,
    model_size: modelSize,
    model_file: modelFile,
    output_base: outputBase,
    output_txt: firstAttempt.output_txt || null,
    attempt_used: chosenAttempt.name,
    transcription_text: text,
    transcription_length: text.length,
    transcription_word_count: words.length,
    whisper_exit_status: chosenAttempt.exit_status,
    whisper_stderr: chosenAttempt.stderr,
    first_attempt_status: firstAttempt.exit_status,
    first_attempt_stderr: firstAttempt.stderr,
    whisper_transcription_run_now: true,
    microphone_recorded_now: false,
    vad_audio_analysis_run_now: false,
    yolo_inference_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    minecraft_called: false
  });

  const reportFile = writeWhisperReport(status);

  return Object.freeze({
    ...status,
    report_file: reportFile
  });
}

function printWhisperTranscriptionProof() {
  const status = runWhisperTranscriptionProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printWhisperTranscriptionProof();
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  WHISPER_CLI,
  WHISPER_MODEL_DIR,
  MICROPHONE_INPUT_DIR,
  WHISPER_OUTPUT_DIR,
  fileReady,
  executableReady,
  whisperTranscriptionAllowed,
  whisperGuardStatus,
  latestMicrophoneWav,
  whisperModelPath,
  cleanTranscriptionText,
  textLooksLikeSpeech,
  runWhisperTxtAttempt,
  runWhisperStdoutAttempt,
  runWhisperTranscriptionProof,
  printWhisperTranscriptionProof
};
