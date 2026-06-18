'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PROJECT_ROOT: ROOT, getTimeoutConfig } = require('../config/floki-config.cjs');
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const VENV_DIR = path.join(TOOLS_DIR, 'venv-chat-embodiment');
const PYTHON = path.join(VENV_DIR, 'bin', 'python');
const MICROPHONE_INPUT_DIR = path.join(TOOLS_DIR, 'input', 'microphone-smoke');
const VAD_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'vad-smoke');

function fileReady(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 44;
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

function vadAnalysisAllowed(env = process.env) {
  return env.FLOKI_ALLOW_VAD_ANALYSIS === '1';
}

function vadGuardStatus(env = process.env) {
  const allowed = vadAnalysisAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_VAD_ANALYSIS=1',
    vad_audio_analysis_run_now: false,
    reason: allowed
      ? 'VAD audio analysis is explicitly allowed for this one proof run.'
      : 'VAD analysis is guarded. Run npm run proof:vad-speech-detection to analyze the latest microphone WAV.'
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

function buildPythonVadScript() {
  return [
    'import json',
    'import sys',
    'from silero_vad import load_silero_vad, read_audio, get_speech_timestamps',
    '',
    'audio_path = sys.argv[1]',
    'model = load_silero_vad()',
    'wav = read_audio(audio_path, sampling_rate=16000)',
    'speech_timestamps = get_speech_timestamps(wav, model, return_seconds=True)',
    'duration_seconds = 0.0',
    'try:',
    '    duration_seconds = float(len(wav)) / 16000.0',
    'except Exception:',
    '    duration_seconds = 0.0',
    'total_speech_seconds = 0.0',
    'normalized = []',
    'for item in speech_timestamps:',
    '    start = float(item.get("start", 0.0))',
    '    end = float(item.get("end", 0.0))',
    '    if end < start:',
    '        end = start',
    '    total_speech_seconds += max(0.0, end - start)',
    '    normalized.append({"start": start, "end": end, "duration": max(0.0, end - start)})',
    'print(json.dumps({',
    '    "ok": True,',
    '    "speech_detected": len(normalized) > 0,',
    '    "speech_segment_count": len(normalized),',
    '    "total_speech_seconds": round(total_speech_seconds, 4),',
    '    "duration_seconds": round(duration_seconds, 4),',
    '    "speech_timestamps": normalized',
    '}))'
  ].join('\n');
}

function runPythonVad(inputFile) {
  const script = buildPythonVadScript();

  const result = spawnSync(PYTHON, ['-c', script, inputFile], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: getTimeoutConfig('chat').vad_ms,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    }
  });

  let parsed = null;

  if (result.status === 0) {
    try {
      parsed = JSON.parse(String(result.stdout || '').trim());
    } catch (_error) {
      parsed = null;
    }
  }

  return Object.freeze({
    ok: result.status === 0 && parsed && parsed.ok === true,
    status: result.status,
    stdout: String(result.stdout || '').trim().slice(0, 2000),
    stderr: String(result.stderr || '').trim().slice(0, 1000),
    parsed
  });
}

function writeVadReport(status) {
  fs.mkdirSync(VAD_OUTPUT_DIR, { recursive: true });
  const reportFile = path.join(VAD_OUTPUT_DIR, 'latest-vad-speech-detection.json');
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
}

function runVadSpeechDetectionProof(options = {}) {
  const guard = vadGuardStatus(options.env || process.env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_BLOCKED',
      guard,
      vad_audio_analysis_run_now: false,
      microphone_recorded_now: false,
      whisper_transcription_run_now: false,
      yolo_inference_run_now: false,
      piper_speech_run_now: false,
      speaker_playback_run_now: false,
      minecraft_called: false
    });
  }

  if (!executableReady(PYTHON)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_FAIL',
      reason: 'Python venv is not executable',
      python_path: PYTHON,
      vad_audio_analysis_run_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const chosenInput = options.input_file || process.env.FLOKI_VAD_INPUT || null;
  const latest = chosenInput
    ? { file_path: chosenInput, size_bytes: fileReady(chosenInput) ? fs.statSync(chosenInput).size : 0 }
    : latestMicrophoneWav();

  if (!latest || !fileReady(latest.file_path)) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_VAD_SPEECH_DETECTION_FAIL',
      reason: 'No microphone WAV ready. Run npm run proof:microphone-capture first.',
      microphone_input_dir: MICROPHONE_INPUT_DIR,
      vad_audio_analysis_run_now: false,
      microphone_recorded_now: false,
      minecraft_called: false
    });
  }

  const vad = runPythonVad(latest.file_path);
  const speech = vad.parsed || {};
  const ok = vad.ok === true &&
    speech.speech_detected === true &&
    Number(speech.speech_segment_count || 0) > 0 &&
    Number(speech.total_speech_seconds || 0) > 0;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_VAD_SPEECH_DETECTION_PASS' : 'FLOKI_V2_VAD_SPEECH_DETECTION_FAIL',
    input_file: latest.file_path,
    input_size_bytes: latest.size_bytes,
    python_path: PYTHON,
    speech_detected: speech.speech_detected === true,
    speech_segment_count: Number(speech.speech_segment_count || 0),
    total_speech_seconds: Number(speech.total_speech_seconds || 0),
    duration_seconds: Number(speech.duration_seconds || 0),
    speech_timestamps: Array.isArray(speech.speech_timestamps) ? speech.speech_timestamps : [],
    vad_exit_status: vad.status,
    vad_stderr: vad.stderr,
    vad_audio_analysis_run_now: true,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    yolo_inference_run_now: false,
    piper_speech_run_now: false,
    speaker_playback_run_now: false,
    minecraft_called: false
  });

  const reportFile = writeVadReport(status);

  return Object.freeze({
    ...status,
    report_file: reportFile
  });
}

function printVadSpeechDetectionProof() {
  const status = runVadSpeechDetectionProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printVadSpeechDetectionProof();
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  VENV_DIR,
  PYTHON,
  MICROPHONE_INPUT_DIR,
  VAD_OUTPUT_DIR,
  fileReady,
  executableReady,
  vadAnalysisAllowed,
  vadGuardStatus,
  latestMicrophoneWav,
  buildPythonVadScript,
  runPythonVad,
  runVadSpeechDetectionProof,
  printVadSpeechDetectionProof
};
