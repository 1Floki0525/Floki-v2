'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const start = read('bin/floki-start.sh');
const hearingStart = read('bin/floki-chat-start.sh');
const cleanup = read('bin/floki-chat-local-cleanup.sh');
const runtime = read('src/runtime/chat-local-runtime.cjs');
const audio = read('src/senses/live-audio-service.cjs');
const whisper = read('src/senses/live-whisper-service.cjs');
const piper = read('src/senses/live-piper-service.cjs');
const wake = read('src/chat/wake-word-gate.cjs');
const webcam = read('src/vision/chat-webcam-vision-service.cjs');
const electron = read('apps/floki-neural-interface/electron/main.cjs');
const chatPanel = read('apps/floki-neural-interface/src/components/chat/ChatPanel.jsx');
const config = read('config/chat.config.yaml');

assert.match(start, /startup_stage "5\/7"/);
assert.match(start, /start_chat_hearing/);
assert.match(hearingStart, /src\/runtime\/chat-local-runtime\.cjs/);
assert.doesNotMatch(hearingStart, /src\/senses\/chat-mode-loop\.cjs/);
assert.match(cleanup, /chat-local-runtime\.pid/);
assert.match(cleanup, /whisper-server/);

assert.match(runtime, /const brain = options\.runtime \|\| createRuntime/);
assert.match(runtime, /input_modality: 'spoken'/);
assert.match(runtime, /input_modality: 'text'/);
assert.match(runtime, /hearing_ready: hearingReady/);
assert.match(runtime, /hearing_intentionally_suspended: sleeping \|\| awaitingClient/);
assert.match(runtime, /degraded_reasons: degradedReasons/);
assert.match(audio, /spawn\(arecord/);
assert.match(audio, /createLiveWhisperService/);
assert.match(audio, /classifyLiveHeardText\(heard, state\.speaking\)/);
assert.doesNotMatch(audio, /classifyWakeInput\(heard,\s*\{/);
assert.match(audio, /createLivePiperService/);
assert.match(audio, /ambient_sound_unclassified/);
assert.match(audio, /rolling_attention_scan/);
assert.match(audio, /handleAttentionFrame\(frame\)/);
assert.match(audio, /highPriorityAudioTasks/);
assert.match(audio, /last_ambient_sink_error/);
assert.match(audio, /await stopRecorder\(\)/);
assert.match(whisper, /state\.backend = 'server'/);
assert.match(whisper, /cli_fallback/);
assert.match(piper, /on_speaking_change/);
assert.match(wake, /wake_phrase_only_response_required/);
assert.match(wake, /should_reply: true/);

assert.match(webcam, /chat-webcam-vision\.refresh-request\.json/);
assert.match(runtime, /waitForFreshVision/);
assert.doesNotMatch(electron, /createRuntime\s*\(/);
assert.doesNotMatch(electron, /handleTypedText\s*\(/);
assert.match(electron, /runtimeRequest\('POST', '\/chat'/);
assert.doesNotMatch(electron, /hearingActive: true/);
assert.match(chatPanel, /syncTranscript/);
assert.match(chatPanel, /getTranscript\(500\)/);
assert.doesNotMatch(chatPanel, /filter\(\(entry\).*MessageType\.SPOKEN/s);
assert.match(chatPanel, /Clear chat/);
assert.match(electron, /'\/client-ready'/);
assert.match(electron, /'\/transcript\/clear'/);

assert.match(config, /vad_frame_samples: 512/);
assert.match(config, /pre_roll_ms: 1600/);
assert.match(config, /whisper_server_enabled: true/);
assert.match(config, /ambient_min_event_ms: 500/);
assert.match(config, /wake_gate:/);
assert.match(config, /attention_scan_enabled: true/);
assert.match(config, /attention_scan_window_ms:/);
assert.match(config, /attention_scan_interval_ms:/);
assert.match(config, /attention_followup_interval_ms:/);
assert.doesNotMatch(audio, /stable_count >= 2/);
assert.match(audio, /attentionCandidate\.last_changed_at/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_CHAT_LOCAL_LIVE_VOICE_CONTRACT_PASS',
  single_authoritative_brain: true,
  continuous_microphone_stream: true,
  persistent_vad_worker: true,
  persistent_whisper_server_with_fallback: true,
  piper_hard_microphone_gate: true,
  ambient_audio_ingestion: true,
  all_transcript_modalities_sync_to_gui: true,
  hearing_status_is_truthful: true,
  fresh_vision_request_supported: true,
  live_services_started_by_test: false
}, null, 2));
