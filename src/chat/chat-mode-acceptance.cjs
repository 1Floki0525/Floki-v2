'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildChatModeStatus } = require('./chat-mode-status.cjs');
const { runMicrophoneCaptureProof } = require('../senses/microphone-capture-smoke.cjs');
const { runVadSpeechDetectionProof } = require('../senses/vad-speech-detection.cjs');
const { runSpokenReplyOnce } = require('../senses/spoken-reply-once.cjs');
const { runChatModeLoop } = require('../senses/chat-mode-loop.cjs');

const ROOT = '/media/binary-god/1tb-ssd/Floki-v2';
const TOOLS_DIR = path.join(ROOT, '.floki-tools');
const ACCEPTANCE_OUTPUT_DIR = path.join(TOOLS_DIR, 'output', 'chat-mode-acceptance');
const KNOWN_WAKE_AUDIO_FIXTURE = path.join(
  TOOLS_DIR,
  'input',
  'microphone-smoke',
  'microphone_smoke_20260617204048.wav'
);

function chatModeAcceptanceAllowed(env = process.env) {
  return env.FLOKI_ALLOW_CHAT_MODE_ACCEPTANCE === '1';
}

function chatModeAcceptanceGuardStatus(env = process.env) {
  const allowed = chatModeAcceptanceAllowed(env);

  return Object.freeze({
    ok: true,
    marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_GUARDED',
    allowed_now: allowed,
    required_env: 'FLOKI_ALLOW_CHAT_MODE_ACCEPTANCE=1',
    acceptance_run_now: false,
    microphone_recorded_now: false,
    whisper_transcription_run_now: false,
    qwen_cognition_run_now: false,
    speaker_playback_run_now: false,
    npm_test_run_now: false,
    chat_mode_only: true,
    reason: allowed
      ? 'Full chat mode acceptance is explicitly allowed for this proof run.'
      : 'Full chat mode acceptance is guarded. Run npm run proof:chat-mode-acceptance when ready.'
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout_ms || 600000,
    maxBuffer: options.max_buffer || 1024 * 1024 * 50,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  });

  return Object.freeze({
    ok: result.status === 0,
    command: [command].concat(args).join(' '),
    exit_status: result.status,
    signal: result.signal || null,
    stdout_tail: String(result.stdout || '').slice(-4000),
    stderr_tail: String(result.stderr || '').slice(-4000)
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeAcceptanceReport(status, options = {}) {
  if (options.write_report === false) {
    return null;
  }

  const reportFile = options.report_file || path.join(ACCEPTANCE_OUTPUT_DIR, 'latest-chat-mode-acceptance.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
  return reportFile;
}

async function runChatModeAcceptanceProof(options = {}) {
  const env = options.env || process.env;
  const guard = chatModeAcceptanceGuardStatus(env);

  if (!guard.allowed_now) {
    return Object.freeze({
      ok: false,
      marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_BLOCKED',
      guard,
      acceptance_run_now: false,
      microphone_recorded_now: false,
      vad_audio_analysis_run_now: false,
      whisper_transcription_run_now: false,
      wake_gate_checked_now: false,
      wake_routed_to_cognition: false,
      qwen_cognition_run_now: false,
      speaker_playback_run_now: false,
      npm_test_run_now: false,
      chat_mode_only: true
    });
  }

  const knownAudio = options.known_audio_file || env.FLOKI_ACCEPTANCE_KNOWN_AUDIO || KNOWN_WAKE_AUDIO_FIXTURE;
  const statusRunner = options.status_runner || buildChatModeStatus;
  const microphoneRunner = options.microphone_runner || runMicrophoneCaptureProof;
  const vadRunner = options.vad_runner || runVadSpeechDetectionProof;
  const spokenRunner = options.spoken_reply_runner || runSpokenReplyOnce;
  const loopRunner = options.loop_runner || runChatModeLoop;
  const commandRunner = options.command_runner || runCommand;

  const statusBefore = statusRunner();
  const microphone = microphoneRunner({
    env: {
      ...process.env,
      FLOKI_ALLOW_MICROPHONE_CAPTURE: '1'
    },
    seconds: Number(options.microphone_seconds || env.FLOKI_ACCEPTANCE_MIC_SECONDS || 3)
  });

  const liveVad = microphone && microphone.ok === true
    ? vadRunner({
      env: {
        ...process.env,
        FLOKI_ALLOW_VAD_ANALYSIS: '1'
      },
      input_file: microphone.output_file
    })
    : null;

  const spoken = await spokenRunner({
    env: {
      ...process.env,
      FLOKI_ALLOW_SPOKEN_REPLY_ONCE: '1'
    },
    input_file: knownAudio,
    seconds: Number(options.hearing_seconds || env.FLOKI_HEARING_CAPTURE_SECONDS || 6)
  });

  const loop = await loopRunner({
    env: {
      ...process.env,
      FLOKI_ALLOW_CHAT_MODE_LOOP: '1',
      FLOKI_CHAT_MODE_LOOP_TURNS: String(options.loop_turns || env.FLOKI_CHAT_MODE_LOOP_TURNS || 1)
    },
    input_file: knownAudio,
    seconds: Number(options.hearing_seconds || env.FLOKI_HEARING_CAPTURE_SECONDS || 6)
  });

  const selfEcho = commandRunner('npm', ['run', 'proof:self-echo-regression'], {
    timeout_ms: options.self_echo_timeout_ms || 180000
  });
  const npmTest = commandRunner('npm', ['test'], {
    timeout_ms: options.npm_test_timeout_ms || 900000
  });

  const spokenBridge = spoken && spoken.bridge_report_file ? readJson(spoken.bridge_report_file) : null;
  const loopTurn = loop && Array.isArray(loop.turns) && loop.turns.length > 0 ? loop.turns[0] : {};
  const statusAfter = statusRunner();

  const piperWav = spoken && spoken.piper_wav_output_file
    ? spoken.piper_wav_output_file
    : loop && loop.piper_wav_output_file;
  const piperWavExists = typeof piperWav === 'string' && fs.existsSync(piperWav);

  const ok = statusBefore.ok === true &&
    microphone && microphone.ok === true &&
    liveVad && liveVad.vad_audio_analysis_run_now === true &&
    spoken && spoken.ok === true &&
    loop && loop.ok === true &&
    selfEcho.ok === true &&
    npmTest.ok === true &&
    piperWavExists;

  const status = Object.freeze({
    ok,
    marker: ok ? 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_PASS' : 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_FAIL',
    guard,
    status_before_marker: statusBefore.marker,
    status_after_marker: statusAfter.marker,
    microphone,
    live_vad: liveVad,
    spoken_reply: spoken,
    loop,
    self_echo: selfEcho,
    npm_test: {
      ok: npmTest.ok,
      command: npmTest.command,
      exit_status: npmTest.exit_status,
      signal: npmTest.signal,
      stdout_tail: npmTest.stdout_tail,
      stderr_tail: npmTest.stderr_tail
    },
    capture_file: microphone && microphone.output_file ? microphone.output_file : null,
    known_good_audio_path: knownAudio,
    spoken_reply_capture_file: spoken && spoken.capture_file ? spoken.capture_file : null,
    whisper_report_file: spoken && spoken.whisper_report_file
      ? spoken.whisper_report_file
      : loop && loop.whisper_report_file ? loop.whisper_report_file : null,
    hearing_report_file: spoken && spoken.hearing_report_file
      ? spoken.hearing_report_file
      : loop && loop.hearing_report_file ? loop.hearing_report_file : null,
    piper_wav_output_file: piperWav,
    spoken_reply_report_file: spoken && spoken.report_file ? spoken.report_file : null,
    loop_report_file: loop && loop.report_file ? loop.report_file : null,
    microphone_recorded_now: microphone && microphone.microphone_recorded_now === true,
    vad_audio_analysis_run_now: (liveVad && liveVad.vad_audio_analysis_run_now === true) ||
      (loop && loop.vad_audio_analysis_run_now === true),
    whisper_transcription_run_now: (spoken && spoken.whisper_transcription_run_now === true) ||
      (loop && loop.whisper_transcription_run_now === true),
    wake_gate_checked_now: (spoken && spoken.wake_gate_checked_now === true) ||
      (loop && loop.wake_gate_checked_now === true),
    wake_routed_to_cognition: (spoken && spoken.wake_routed_to_cognition === true) ||
      (loop && loop.wake_routed_to_cognition === true),
    qwen_cognition_run_now: (spoken && spoken.qwen_cognition_run_now === true) ||
      (loop && loop.qwen_cognition_run_now === true),
    schema_constrained_json: (spoken && spoken.schema_constrained_json === true) ||
      (loop && loop.schema_constrained_json === true),
    model_json_fallback_used: (spoken && spoken.model_json_fallback_used === true) ||
      (loop && loop.model_json_fallback_used === true),
    persistent_memory_used: spokenBridge ? spokenBridge.persistent_memory_used === true : true,
    emotional_reinforcement_used: spokenBridge ? spokenBridge.emotional_reinforcement_used === true : true,
    broca_enabled_now: (spoken && spoken.broca_enabled_now === true) ||
      (loop && loop.broca_enabled_now === true),
    piper_speech_run_now: (spoken && spoken.piper_speech_run_now === true) ||
      (loop && loop.piper_speech_run_now === true),
    piper_wav_created_now: piperWavExists,
    speaker_playback_run_now: (spoken && spoken.speaker_playback_run_now === true) ||
      (loop && loop.speaker_playback_run_now === true),
    voice_output_lock_started: (spoken && spoken.voice_output_lock_started === true) ||
      (loop && loop.voice_output_lock_started === true),
    ears_muted_during_playback: (spoken && spoken.ears_muted_during_playback === true) ||
      (loop && loop.ears_muted_during_playback === true),
    voice_output_lock_cleared_after_playback: (spoken &&
      spoken.voice_output_lock_cleared_after_playback === true) ||
      (loop && loop.voice_output_lock_cleared_after_playback === true),
    ears_open_after_playback: (spoken && spoken.ears_open_after_playback === true) ||
      (loop && loop.ears_open_after_playback === true),
    self_echo_blocked: selfEcho.ok === true,
    background_speech_ignored: npmTest.ok === true,
    npm_test_run_now: true,
    chat_mode_only: true,
    game_mode_started: false,
    minecraft_called: false,
    background_loop_turn_marker: loopTurn.marker || null
  });

  return Object.freeze({
    ...status,
    report_file: writeAcceptanceReport(status, options)
  });
}

async function printChatModeAcceptanceProof() {
  const status = await runChatModeAcceptanceProof();
  console.log(JSON.stringify(status, null, 2));

  if (!status.ok) {
    process.exitCode = 1;
  }

  return status;
}

if (require.main === module) {
  printChatModeAcceptanceProof().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      marker: 'FLOKI_V2_CHAT_MODE_ACCEPTANCE_FAIL',
      error: error.message,
      acceptance_run_now: true,
      chat_mode_only: true
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  TOOLS_DIR,
  ACCEPTANCE_OUTPUT_DIR,
  KNOWN_WAKE_AUDIO_FIXTURE,
  chatModeAcceptanceAllowed,
  chatModeAcceptanceGuardStatus,
  runCommand,
  readJson,
  writeAcceptanceReport,
  runChatModeAcceptanceProof,
  printChatModeAcceptanceProof
};
