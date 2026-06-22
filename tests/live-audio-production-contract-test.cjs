'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT: ROOT, getAudioConfig, getWakeGateConfig } = require('../src/config/floki-config.cjs');
const { parseWhisperResult, writeWavPcm16, classifyLiveHeardText } = require('../src/senses/live-audio-service.cjs');

function run() {
  const source = fs.readFileSync(path.join(ROOT, 'src/senses/live-audio-service.cjs'), 'utf8');
  const whisper = fs.readFileSync(path.join(ROOT, 'src/senses/live-whisper-service.cjs'), 'utf8');
  const piper = fs.readFileSync(path.join(ROOT, 'src/senses/live-piper-service.cjs'), 'utf8');
  const config = getAudioConfig('chat');
  const wakeConfig = getWakeGateConfig('chat');
  const wakePhrase = wakeConfig.required_phrase;

  assert.match(source, /spawn\(arecord/);
  assert.doesNotMatch(source, /spawnSync\([^\n]*arecord/);
  assert.match(source, /createLiveWhisperService/);
  assert.match(source, /createLivePiperService/);
  assert.match(source, /await stopRecorder\(\)/);
  assert.match(source, /if \(state\.awake && !stopping\) startRecorder\(\)/);
  assert.match(source, /fs\.rmSync\(wavFile, \{ force: true \}\)/);
  assert.match(source, /ambient_speech/);
  assert.match(source, /ambient_sound/);
  assert.match(source, /ambient_sound_unclassified/);
  assert.doesNotMatch(source, /classifyWakeInput\(heard,\s*\{/);
  assert.match(source, /classifyLiveHeardText\(heard, state\.speaking\)/);
  const direct = classifyLiveHeardText(wakePhrase + ', what do you see?', false);
  assert.equal(direct.gate_open, true);
  assert.equal(direct.should_reply, true);
  assert.equal(direct.request_text, 'what do you see?');
  const echo = classifyLiveHeardText(wakePhrase + ', repeat yourself', true);
  assert.equal(echo.gate_open, false);
  assert.equal(echo.ears_must_be_muted, true);
  assert.match(whisper, /whisper-server/);
  assert.match(whisper, /cli_fallback/);
  assert.match(piper, /runPlaybackWithVoiceLockAsync/);
  assert.equal(config.vad_frame_samples, 512);
  assert.equal(config.whisper_server_enabled, true);
  assert.ok(config.pre_roll_ms >= 1000);
  assert.ok(config.ambient_min_event_ms > 0);
  assert.equal(config.attention_scan_enabled, true);
  assert.ok(config.attention_scan_window_ms > config.attention_scan_interval_ms);
  assert.ok(config.attention_scan_interval_ms > config.attention_followup_interval_ms);
  assert.doesNotMatch(source, /stable_count >= 2/);
  assert.match(source, /attentionCandidate\.last_changed_at/);
  assert.match(source, /const hasCommand = attentionCandidate\.classification\.attention_only !== true/);
  assert.ok(config.attention_scan_min_audio_ms > 0);
  assert.ok(Object.keys(wakeConfig.accepted_phrases).length >= 1);
  assert.match(source, /handleAttentionFrame\(frame\)/);
  assert.match(source, /rolling_attention_scan/);
  assert.match(source, /highPriorityAudioTasks/);
  assert.match(source, /last_ambient_sink_error/);

  const parsed = parseWhisperResult('[dog barking] ' + wakePhrase + ', what do you see?');
  assert.deepEqual(parsed.ambient_labels, ['dog barking']);
  assert.equal(parsed.speech_text, wakePhrase + ', what do you see?');

  const tmp = path.join(ROOT, 'state/floki/test/live-audio-contract-' + process.pid + '.wav');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  writeWavPcm16(tmp, Buffer.alloc(1024), 16000, 1);
  const header = fs.readFileSync(tmp).subarray(0, 12).toString('ascii');
  fs.rmSync(tmp, { force: true });
  assert.equal(header.startsWith('RIFF'), true);
  assert.equal(header.slice(8, 12), 'WAVE');

  console.log(JSON.stringify({ ok: true, marker: 'FLOKI_V2_LIVE_AUDIO_PRODUCTION_CONTRACT_PASS', continuous_microphone_process: true, persistent_vad_worker: true, persistent_whisper_server_with_cli_fallback: true, piper_echo_gate: true, temporary_audio_deleted: true, ambient_audio_ingestion: true, chat_mode_only: true }, null, 2));
}

try { run(); } catch (error) { console.error(JSON.stringify({ ok: false, marker: 'FLOKI_V2_LIVE_AUDIO_PRODUCTION_CONTRACT_FAIL', error: error.message }, null, 2)); process.exit(1); }
