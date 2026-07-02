'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createRuntime, handleUserText } = require('./floki-chat.cjs');
const { cognitionJsonFromOutput, speechJsonFromOutput, loadCoreBrainConfig } = require('../../brain/core_brain/index.cjs');
const { appendChatTranscriptTurn, appendPrivateThoughtRecord, assertPublicTranscriptText, readChatTranscriptTail, getTranscriptPaths } = require('./chat-transcript.cjs');
const { buildVisionStatus } = require('../vision/vision-status.cjs');
const {
  buildFlokiLifecycleStatus,
  formatLifecycleStateLine,
  lifecycleTransitionLabel,
  printLifecycleStatus
} = require('./floki-lifecycle-status.cjs');
const {
  readChatWebcamVisionStatus,
  readLatestPrivateObservation,
  stopChatWebcamVisionService,
  formatChatWebcamVisionLines
} = require('../vision/chat-webcam-vision-service.cjs');

const { PROJECT_ROOT: ROOT, getTimeoutConfig, getPathConfig, getSleepConfig, getLiveChatConfig } = require('../../src/config/floki-config.cjs');
const { createLatencyTrace } = require('../util/latency-trace.cjs');
const { beginLivingTurn, completeLivingTurn } = require('./living-continuity.cjs');

function jsonStatus(ok, marker, extra = {}) {
  return Object.freeze({ ok, marker, ...extra, chat_mode_only: true, game_mode_started: false });
}

function firstPersonInnerSummary(category, value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^(?:I|I'm|I’m|I've|I’ve|I'll|I’ll|My|Me)\b/i.test(text)) return text;
  const lowered = text.charAt(0).toLowerCase() + text.slice(1);
  if (category === 'emotion') return 'I feel that ' + lowered;
  if (category === 'memory') return 'I connect this with ' + lowered;
  if (category === 'identity') return 'I notice that ' + lowered;
  if (category === 'intention') return 'I intend to ' + lowered;
  return 'I reflect that ' + lowered;
}

function cognitionInnerEvents(cognition, result, options = {}) {
  const eventId = result && result.event && result.event.id ? result.event.id : null;
  const source = options.source || 'live_chat_interface';
  const events = [];
  const add = (category, text) => {
    const normalized = firstPersonInnerSummary(category, text);
    if (!normalized) return;
    events.push(Object.freeze({ text: normalized, category, source, event_id: eventId }));
  };

  add('reflection', cognition.safe_thought_summary);
  add('emotion', cognition.felt_interpretation);
  for (const value of Array.isArray(cognition.memory_links) ? cognition.memory_links : []) add('memory', value);
  for (const value of Array.isArray(cognition.personality_implications) ? cognition.personality_implications : []) add('identity', value);
  for (const value of Array.isArray(cognition.identity_implications) ? cognition.identity_implications : []) add('identity', value);
  add('memory', cognition.new_memory_summary);

  const knowledge = result && result.knowledgeContext && Array.isArray(result.knowledgeContext.knowledge_matches)
    ? result.knowledgeContext.knowledge_matches[0]
    : null;
  if (knowledge && knowledge.summary) {
    const origin = [knowledge.title, knowledge.channel_folder].filter(Boolean).join(' from ');
    add('memory', 'I remember reading' + (origin ? ' “' + origin + '”' : ' saved knowledge') + ': ' + String(knowledge.summary).slice(0, 600));
  }

  return Object.freeze(events);
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
  const chatWebcamVisionStatus = readChatWebcamVisionStatus();
  const visionStatus = buildVisionStatus({
    active_mode: 'chat',
    webcam_status: {
      measured_fps: chatWebcamVisionStatus.measured_capture_fps
    }
  });
  const lifecycleStatus = buildFlokiLifecycleStatus();
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
    chat_webcam_vision_status: chatWebcamVisionStatus,
    lifecycle_status: lifecycleStatus,
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

function lifecycleSignature(status) {
  return [
    status.state,
    status.current_rem_cycle_number || 'none',
    status.stale_dreaming_state_detected ? 'stale' : 'clean'
  ].join(':');
}

async function handleTypedText(runtime, text, options = {}) {
  const liveChat = getLiveChatConfig('chat');
  const model = runtime.config.models.cognition;
  const paths = getPathConfig('chat');
  const trace = options.latency_trace || createLatencyTrace({
    input_modality: options.input_modality || 'text',
    configured_model: model.model,
    configured_endpoint: model.endpoint,
    schema_enabled: true,
    streaming_enabled: liveChat.public_response_streaming_enabled === true,
    log_path: path.join(ROOT, paths.chat_runtime_root, 'latency-events.jsonl'),
    max_log_bytes: liveChat.latency_log_max_bytes,
    on_event: options.on_latency_event
  });

  trace.emit('request_accepted', { input_character_count: String(text || '').length });
  if (options.user_transcript_recorded !== true) {
    const userTranscript = appendChatTranscriptTurn({ role: 'user', text: String(options.transcript_user_text || text), input_modality: options.input_modality || 'text', output_modality: 'none', spoken_aloud: false, source: options.source || 'live_chat_interface' });
    if (userTranscript.written && typeof options.on_transcript_entry === 'function') options.on_transcript_entry(userTranscript.entry);
  }

  const cachedVision = options.chat_webcam_vision !== undefined
    ? options.chat_webcam_vision
    : readLatestPrivateObservation();
  trace.emit('cached_vision_ready', {
    cached_vision_available: cachedVision && cachedVision.available === true,
    cached_vision_fresh: cachedVision && cachedVision.fresh === true
  });

  const livingTurn = beginLivingTurn({
    text,
    source: options.source || 'live_chat_interface',
    input_modality: options.input_modality || 'text'
  });

  let displayedText = null;
  const result = await handleUserText(runtime, text, {
    chat_webcam_vision: cachedVision,
    vision_question: options.vision_question === true,
    vision_hardware_question: options.vision_hardware_question === true,
    persistent_chat_memory: livingTurn.persistent_chat_memory,
    emotional_reinforcement: livingTurn.emotional_reinforcement,
    soul_context: livingTurn.soul_context,
    model_config: options.model_config,
    signal: options.signal,
    latency_trace: trace,
    streaming_enabled: options.streaming_enabled,
    post_json: options.post_json,
    post_json_stream: options.post_json_stream,
    on_public_text(payload) {
      if (displayedText !== null) return;
      displayedText = payload.text;
      if (options.print_public_text !== false) console.log('floki> ' + payload.text);
      if (typeof options.on_public_text === 'function') options.on_public_text(payload);
    },
    on_first_sentence: options.on_first_sentence,
    on_model_dispatched: options.on_model_dispatched,
    on_first_chunk: options.on_first_chunk,
    on_final_model_output: options.on_final_model_output,
    on_schema_valid: options.on_schema_valid
  });

  const cognition = cognitionJsonFromOutput(result.cognitionOutput);
  const speech = speechJsonFromOutput(result.speechOutput);
  const interrupted = options.signal && options.signal.aborted ||
    result.cognitionOutput && result.cognitionOutput.failure && result.cognitionOutput.failure.code === 'FRONTAL_COGNITION_INTERRUPTED';

  if (interrupted) {
    trace.emit('response_interrupted', { completion_status: 'interrupted', error_code: 'FRONTAL_COGNITION_INTERRUPTED' });
    return jsonStatus(false, 'FLOKI_V2_LIVE_CHAT_TEXT_REPLY_INTERRUPTED', {
      transcript_recorded_now: false,
      response_interrupted: true,
      trace_id: trace.trace_id,
      turn_id: trace.turn_id
    });
  }

  const reply = speech.enabled ? speech.text : String(speech.error || 'I could not form a reply.');
  if (!speech.enabled) {
    trace.emit('response_failed', { completion_status: 'failed', error_code: 'BROCA_RESPONSE_FAILED' });
    return jsonStatus(false, 'FLOKI_V2_LIVE_CHAT_TEXT_REPLY_FAILED', {
      transcript_recorded_now: false,
      error: reply,
      trace_id: trace.trace_id,
      turn_id: trace.turn_id
    });
  }

  assertPublicTranscriptText(reply, 'typed chat Floki reply');
  if (displayedText !== null && displayedText !== reply) {
    trace.emit('response_failed', { completion_status: 'failed', error_code: 'PUBLIC_RESPONSE_MISMATCH' });
    throw new Error('final typed reply differs from the streamed Broca-authorized reply');
  }
  if (displayedText === null) {
    displayedText = reply;
    if (options.print_public_text !== false) console.log('floki> ' + reply);
    if (typeof options.on_public_text === 'function') options.on_public_text(Object.freeze({ text: reply, final_only: true }));
  }

  const livingContinuity = completeLivingTurn({
    turn: livingTurn,
    runtime,
    result,
    reply,
    source: options.source || 'live_chat_interface',
    input_modality: options.input_modality || 'text'
  });

  const assistantTranscript = appendChatTranscriptTurn({
    role: 'floki',
    text: reply,
    input_modality: options.input_modality || 'text',
    output_modality: options.output_modality || 'text',
    spoken_aloud: options.spoken_aloud === true,
    source: options.source || 'live_chat_interface',
    event_id: result.event && result.event.id ? result.event.id : null
  });
  if (assistantTranscript.written && typeof options.on_transcript_entry === 'function') options.on_transcript_entry(assistantTranscript.entry);
  for (const innerSummary of cognitionInnerEvents(cognition, result, options)) {
    if (typeof options.on_inner_summary === 'function') options.on_inner_summary(innerSummary);
    else appendPrivateThoughtRecord(innerSummary);
  }
  trace.emit('response_completed', { completion_status: 'completed', response_character_count: reply.length, safe_public_text_length: reply.length });

  return jsonStatus(cognition.enabled === true && speech.enabled === true, 'FLOKI_V2_LIVE_CHAT_TEXT_REPLY_RECORDED', {
    transcript_recorded_now: true,
    reply,
    living_continuity: livingContinuity,
    trace_id: trace.trace_id,
    turn_id: trace.turn_id,
    latency_events: trace.events()
  });
}

async function runLiveChatInterface(options = {}) {
  const runtime = createRuntime();
  const noSpeech = process.argv.includes('--no-speech') || options.no_speech === true;
  const knowledgeAutoloadStatus = startKnowledgeAutoload();
  const chatWebcamVisionStatus = readChatWebcamVisionStatus();
  if (chatWebcamVisionStatus.ready_for_chat !== true) {
    throw new Error('chat webcam vision is not ready; start chat through bin/floki-start.sh chat');
  }
  const startStatus = startSpeechLoop({ no_speech: noSpeech });
  const paths = getTranscriptPaths();
  const seenTranscriptIds = loadSeenTranscriptIds();
  const sleepConfig = getSleepConfig('chat');
  let lifecycleStatus = buildFlokiLifecycleStatus();
  let lifecycleStatusSignature = lifecycleSignature(lifecycleStatus);
  console.log('FLOKI_V2_LIVE_CHAT_INTERFACE_READY');
  console.log(formatLifecycleStateLine(lifecycleStatus));
  for (const line of formatChatWebcamVisionLines(chatWebcamVisionStatus)) console.log(line);
  console.log('Text input: type in this terminal.');
  console.log('Spoken input: say wake word, for example: Hey Floki ...');
  console.log('Public transcript: ' + paths.transcript_text_file);
  console.log('Private thought review log: ' + paths.private_thought_text_file);
  console.log('Commands: /help, /status, /state, /sleep-status, /vision-status, /eyes-status, /transcript, /speech-start, /speech-stop, /interrupt, /exit');
  console.log('Knowledge autoload: ' + JSON.stringify(knowledgeAutoloadStatus));
  console.log(JSON.stringify(startStatus, null, 2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  let webcamStopped = false;
  let activeAbortController = null;
  async function stopOwnedWebcamVision() {
    if (webcamStopped) return null;
    webcamStopped = true;
    return stopChatWebcamVisionService();
  }
  const poll = setInterval(() => {
    for (const entry of readChatTranscriptTail(120)) {
      if (!entry || !entry.id || seenTranscriptIds.has(entry.id)) continue;
      seenTranscriptIds.add(entry.id);
      displayTranscriptEntry(entry);
    }
    if (sleepConfig.lifecycle_transition_notifications_enabled === true) {
      const nextLifecycleStatus = buildFlokiLifecycleStatus();
      const nextSignature = lifecycleSignature(nextLifecycleStatus);
      if (nextSignature !== lifecycleStatusSignature) {
        console.log('\n[Floki state] ' + lifecycleTransitionLabel(lifecycleStatus) + ' → ' + lifecycleTransitionLabel(nextLifecycleStatus));
        lifecycleStatus = nextLifecycleStatus;
        lifecycleStatusSignature = nextSignature;
      }
    }
    rl.prompt(true);
  }, Number(sleepConfig.lifecycle_status_poll_ms || 1000));
  rl.prompt();
  rl.on('line', async (line) => {
    const text = String(line || '').trim();
    try {
      if (!text) { rl.prompt(); return; }
      if (text === '/exit' || text === '/quit') {
        if (activeAbortController) activeAbortController.abort();
        clearInterval(poll);
        console.log(JSON.stringify(stopSpeechLoop(), null, 2));
        console.log(JSON.stringify(await stopOwnedWebcamVision(), null, 2));
        rl.close();
        return;
      }
      if (text === '/help') { console.log('Commands: /status, /state, /sleep-status, /vision-status, /eyes-status, /transcript, /speech-start, /speech-stop, /interrupt, /exit'); rl.prompt(); return; }
      if (text === '/status') { printStatus(startStatus); rl.prompt(); return; }
      if (text === '/vision-status' || text === '/eyes-status') { console.log(JSON.stringify(readChatWebcamVisionStatus(), null, 2)); rl.prompt(); return; }
      if (text === '/state' || text === '/sleep-status') { printLifecycleStatus(); rl.prompt(); return; }
      if (text === '/transcript') { for (const entry of readChatTranscriptTail(30)) console.log((entry.role || 'unknown') + ' [' + (entry.input_modality || entry.output_modality || 'unknown') + ']> ' + entry.text); rl.prompt(); return; }
      if (text === '/speech-start') { console.log(JSON.stringify(startSpeechLoop(), null, 2)); rl.prompt(); return; }
      if (text === '/speech-stop') { console.log(JSON.stringify(stopSpeechLoop(), null, 2)); rl.prompt(); return; }
      if (text === '/interrupt') {
        if (activeAbortController) {
          activeAbortController.abort();
          console.log('FLOKI_V2_ACTIVE_RESPONSE_INTERRUPTED');
        } else {
          console.log('FLOKI_V2_NO_ACTIVE_RESPONSE');
        }
        rl.prompt();
        return;
      }
      if (activeAbortController) {
        console.log('Floki is still responding. Use /interrupt before starting another turn.');
        rl.prompt();
        return;
      }
      activeAbortController = new AbortController();
      try {
        await handleTypedText(runtime, text, { signal: activeAbortController.signal });
      } finally {
        activeAbortController = null;
      }
    } catch (error) {
      console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_CHAT_INTERFACE_ERROR', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2));
    }
    rl.prompt();
  });
  rl.on('close', () => {
    clearInterval(poll);
    if (!webcamStopped) {
      stopOwnedWebcamVision()
        .then((status) => { if (status) console.log(JSON.stringify(status, null, 2)); })
        .catch((error) => console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_CHAT_WEBCAM_SERVICE_STOP_ON_CLOSE_FAIL', error: error.message, chat_mode_only: true, game_mode_started: false }, null, 2)))
        .finally(() => console.log('FLOKI_V2_LIVE_CHAT_INTERFACE_CLOSED'));
      return;
    }
    console.log('FLOKI_V2_LIVE_CHAT_INTERFACE_CLOSED');
  });
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
  firstPersonInnerSummary,
  cognitionInnerEvents,
  startSpeechLoop,
  stopSpeechLoop,
  printStatus,
  handleTypedText,
  runLiveChatInterface
};
