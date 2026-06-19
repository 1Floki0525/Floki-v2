'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createRuntime, handleUserText } = require('./floki-chat.cjs');
const { cognitionJsonFromOutput, speechJsonFromOutput, loadCoreBrainConfig } = require('../../brain/core_brain/index.cjs');
const { appendChatTranscriptTurn, appendPrivateThoughtRecord, assertPublicTranscriptText, readChatTranscriptTail, getTranscriptPaths } = require('./chat-transcript.cjs');
const { buildVisionStatus } = require('../vision/vision-status.cjs');

const { PROJECT_ROOT: ROOT, getTimeoutConfig, getPathConfig } = require('../../src/config/floki-config.cjs');

function jsonStatus(ok, marker, extra = {}) {
  return Object.freeze({ ok, marker, ...extra, chat_mode_only: true, game_mode_started: false });
}

function trimOutput(value, maxLength = 4000) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n...[truncated]';
}

function knowledgeAutoloadPaths() {
  const paths = getPathConfig('chat');
  const runtimeDir = paths.chat_runtime_root;
  const script = path.join(ROOT, 'bin', 'floki-knowledge-autoload.sh');
  const logFile = path.join(runtimeDir, 'knowledge-autoload.background.log');

  return Object.freeze({
    runtime_dir: runtimeDir,
    script,
    log_file: logFile
  });
}

function startKnowledgeAutoloadBackground(reason, syncResult = {}) {
  const paths = knowledgeAutoloadPaths();

  fs.mkdirSync(paths.runtime_dir, { recursive: true });

  const out = fs.openSync(paths.log_file, 'a');
  const err = fs.openSync(paths.log_file, 'a');

  const child = spawn('bash', [paths.script], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOKI_KNOWLEDGE_AUTOLOAD_BACKGROUND: '1'
    },
    detached: true,
    stdio: ['ignore', out, err]
  });

  child.unref();

  return jsonStatus(true, 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_BACKGROUND_START_PASS', {
    reason,
    background_pid: child.pid,
    script: paths.script,
    log_file: paths.log_file,
    sync_status: syncResult.status ?? null,
    sync_signal: syncResult.signal ?? null,
    sync_error: syncResult.error ? syncResult.error.message : null,
    sync_timed_out: syncResult.error && syncResult.error.code === 'ETIMEDOUT',
    sync_stdout: trimOutput(syncResult.stdout),
    sync_stderr: trimOutput(syncResult.stderr)
  });
}

function startKnowledgeAutoload() {
  if (process.env.FLOKI_KNOWLEDGE_AUTOLOAD_DISABLED === '1') {
    return jsonStatus(true, 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_DISABLED');
  }

  const paths = knowledgeAutoloadPaths();

  if (!fs.existsSync(paths.script)) {
    return jsonStatus(false, 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_START_FAIL', {
      reason: 'autoload script is missing',
      script: paths.script
    });
  }

  const timeouts = getTimeoutConfig('chat');
  const configuredTimeout = Number(timeouts.knowledge_autoload_ms || 0);

  /*
   * The YAML timeout is intentionally short for contracts, but live startup must
   * not fail just because nvm/bootstrap/corpus ingestion takes longer than 5s.
   * Try a bounded sync run first so RECENTLY_RAN / NO_CORPUS / PASS can display
   * immediately. If it times out, start the same script in the background and
   * report background-start honestly instead of pretending ingestion completed.
   */
  const syncTimeout = Number(process.env.FLOKI_KNOWLEDGE_AUTOLOAD_SYNC_TIMEOUT_MS || Math.max(configuredTimeout, 30000));

  const child = spawnSync('bash', [paths.script], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: syncTimeout
  });

  if (child.status === 0) {
    return jsonStatus(true, 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_START_PASS', {
      status: child.status,
      signal: child.signal || null,
      error: null,
      timeout_ms: syncTimeout,
      stdout: trimOutput(child.stdout),
      stderr: trimOutput(child.stderr)
    });
  }

  if (child.error && child.error.code === 'ETIMEDOUT') {
    return startKnowledgeAutoloadBackground('sync autoload timed out; continuing in background', child);
  }

  if (child.status === null && child.signal) {
    return startKnowledgeAutoloadBackground('sync autoload ended without status; continuing in background', child);
  }

  return jsonStatus(false, 'FLOKI_V2_KNOWLEDGE_AUTOLOAD_START_FAIL', {
    status: child.status,
    signal: child.signal || null,
    error: child.error ? child.error.message : null,
    error_code: child.error ? child.error.code : null,
    timeout_ms: syncTimeout,
    stdout: trimOutput(child.stdout),
    stderr: trimOutput(child.stderr),
    script: paths.script
  });
}

function startSpeechLoop(options = {}) {
  if (options.no_speech === true) return jsonStatus(true, 'FLOKI_V2_LIVE_CHAT_SPEECH_LOOP_DISABLED');
  const timeouts = getTimeoutConfig('chat');
  const result = spawnSync('bash', [path.join(ROOT, 'bin', 'floki-chat-start.sh')], {
    cwd: ROOT,
    env: { ...process.env, FLOKI_CHAT_MODE_LOOP_TURNS: process.env.FLOKI_CHAT_MODE_LOOP_TURNS || '1', FLOKI_HEARING_CAPTURE_SECONDS: process.env.FLOKI_HEARING_CAPTURE_SECONDS || '6' },
    encoding: 'utf8',
    timeout: timeouts.speech_loop_start_ms
  });
  return jsonStatus(result.status === 0, result.status === 0 ? 'FLOKI_V2_LIVE_CHAT_SPEECH_LOOP_START_PASS' : 'FLOKI_V2_LIVE_CHAT_SPEECH_LOOP_START_FAIL', {
    status: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  });
}

function stopSpeechLoop() {
  const result = spawnSync('bash', [path.join(ROOT, 'bin', 'floki-chat-stop.sh')], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: getTimeoutConfig('chat').floki_chat_stop_ms });
  return jsonStatus(result.status === 0, result.status === 0 ? 'FLOKI_V2_LIVE_CHAT_SPEECH_LOOP_STOP_PASS' : 'FLOKI_V2_LIVE_CHAT_SPEECH_LOOP_FAIL', {
    status: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  });
}

function printStatus(startStatus) {
  const config = loadCoreBrainConfig('chat');
  const paths = getTranscriptPaths();
  const visionStatus = buildVisionStatus({ active_mode: 'chat' });
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_LIVE_CHAT_INTERFACE_STATUS',
    accepts_text_input: true,
    accepts_spoken_wake_input: true,
    public_transcript_excludes_private_thoughts: true,
    private_thoughts_stored_separately_for_review_and_memory: true,
    spoken_words_block_private_thought_markers: true,
    speech_loop_start_status: startStatus,
    transcript_jsonl_file: paths.transcript_jsonl_file,
    transcript_text_file: paths.transcript_text_file,
    private_thought_jsonl_file: paths.private_thought_jsonl_file,
    private_thought_text_file: paths.private_thought_text_file,
    config_path: config.source_path,
    cognition_model: config.models.cognition.model,
    broca_enabled_now: true,
    piper_spoken_replies_recorded_to_chat_interface: true,
    vision_status: visionStatus,
    chat_mode_uses_webcam_eyes: visionStatus.chat_mode_uses_webcam_eyes,
    game_mode_uses_first_person_game_view: visionStatus.game_mode_uses_first_person_game_view,
    pineal_mind_eye_used_for_dreams: visionStatus.pineal_mind_eye_used_for_dreams,
    webcam_used_as_game_world_eyes: false,
    desktop_automation_used_for_sight: false,
    mineflayer_used: false,
    minecraft_enabled_now: false,
    chat_mode_only: true,
    game_mode_started: false
  }, null, 2));
}

function displayTranscriptEntry(entry) {
  if (!entry || entry.source !== 'spoken_reply_once') return;
  if (entry.role === 'user' && entry.input_modality === 'spoken') console.log('\nyou (spoken)> ' + entry.text);
  if (entry.role === 'floki') console.log('\nfloki (spoken)> ' + entry.text);
}

function loadSeenTranscriptIds() {
  const seen = new Set();
  for (const entry of readChatTranscriptTail(5000)) if (entry && entry.id) seen.add(entry.id);
  return seen;
}

async function handleTypedText(runtime, text) {
  appendChatTranscriptTurn({ role: 'user', text, input_modality: 'text', output_modality: 'none', spoken_aloud: false, source: 'live_chat_interface' });
  const result = await handleUserText(runtime, text);
  const cognition = cognitionJsonFromOutput(result.cognitionOutput);
  const speech = speechJsonFromOutput(result.speechOutput);
  const reply = speech.enabled ? speech.text : String(speech.error || 'I could not form a reply.');
  assertPublicTranscriptText(reply, 'typed chat Floki reply');
  appendChatTranscriptTurn({ role: 'floki', text: reply, input_modality: 'text', output_modality: 'text', spoken_aloud: false, source: 'live_chat_interface', event_id: result.event && result.event.id ? result.event.id : null });
  if (cognition.safe_thought_summary) appendPrivateThoughtRecord({ text: cognition.safe_thought_summary, source: 'live_chat_interface', event_id: result.event && result.event.id ? result.event.id : null });
  console.log('floki> ' + reply);
  return jsonStatus(cognition.enabled === true && speech.enabled === true, cognition.enabled === true && speech.enabled === true ? 'FLOKI_V2_LIVE_CHAT_TEXT_REPLY_RECORDED' : 'FLOKI_V2_LIVE_CHAT_TEXT_REPLY_FAILED', { transcript_recorded_now: true });
}

async function runLiveChatInterface(options = {}) {
  const runtime = createRuntime();
  const noSpeech = process.argv.includes('--no-speech') || options.no_speech === true;
  const knowledgeAutoloadStatus = startKnowledgeAutoload();
  const startStatus = startSpeechLoop({ no_speech: noSpeech });
  const paths = getTranscriptPaths();
  const seenTranscriptIds = loadSeenTranscriptIds();
  console.log('FLOKI_V2_LIVE_CHAT_INTERFACE_READY');
  console.log('Text input: type in this terminal.');
  console.log('Spoken input: say wake word, for example: Hey Floki ...');
  console.log('Public transcript: ' + paths.transcript_text_file);
  console.log('Private thought review log: ' + paths.private_thought_text_file);
  console.log('Commands: /help, /status, /transcript, /speech-start, /speech-stop, /exit');
  console.log('Knowledge autoload: ' + JSON.stringify(knowledgeAutoloadStatus));
  console.log(JSON.stringify(startStatus, null, 2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  const poll = setInterval(() => {
    for (const entry of readChatTranscriptTail(120)) {
      if (!entry || !entry.id || seenTranscriptIds.has(entry.id)) continue;
      seenTranscriptIds.add(entry.id);
      displayTranscriptEntry(entry);
    }
    rl.prompt(true);
  }, 1000);
  rl.prompt();
  rl.on('line', async (line) => {
    const text = String(line || '').trim();
    try {
      if (!text) { rl.prompt(); return; }
      if (text === '/exit' || text === '/quit') { clearInterval(poll); console.log(JSON.stringify(stopSpeechLoop(), null, 2)); rl.close(); return; }
      if (text === '/help') { console.log('Commands: /status, /transcript, /speech-start, /speech-stop, /exit'); rl.prompt(); return; }
      if (text === '/status') { printStatus(startStatus); rl.prompt(); return; }
      if (text === '/transcript') { for (const entry of readChatTranscriptTail(30)) console.log((entry.role || 'unknown') + ' [' + (entry.input_modality || entry.output_modality || 'unknown') + ']> ' + entry.text); rl.prompt(); return; }
      if (text === '/speech-start') { console.log(JSON.stringify(startSpeechLoop(), null, 2)); rl.prompt(); return; }
      if (text === '/speech-stop') { console.log(JSON.stringify(stopSpeechLoop(), null, 2)); rl.prompt(); return; }
      await handleTypedText(runtime, text);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_CHAT_INTERFACE_ERROR', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2));
    }
    rl.prompt();
  });
  rl.on('close', () => { clearInterval(poll); console.log('FLOKI_V2_LIVE_CHAT_INTERFACE_CLOSED'); });
}

if (require.main === module) {
  runLiveChatInterface().catch((error) => {
    console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_CHAT_INTERFACE_FAIL', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  ROOT,
  startKnowledgeAutoload,
  startKnowledgeAutoloadBackground,
  startSpeechLoop,
  stopSpeechLoop,
  printStatus,
  handleTypedText,
  runLiveChatInterface
};
