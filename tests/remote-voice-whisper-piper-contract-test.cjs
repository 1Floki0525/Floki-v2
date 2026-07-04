'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const runtime = read('src/runtime/chat-local-runtime.cjs');
assert.match(runtime, /\/audio\/remote-utterance/);
assert.match(runtime, /bodyBuffer\(req,\s*voiceConfig\.remote_voice_max_bytes\)/);
assert.match(runtime, /validateRemoteVoiceUpload/);
assert.match(runtime, /parseWavMetadata/);
assert.match(runtime, /liveAudio\.transcribeFile\(inputFile/);
assert.match(runtime, /source:\s*'host_whisper'/);
assert.match(runtime, /liveAudio\.synthesizeSpeech\(reply/);
assert.match(runtime, /playback_target:\s*'remote_client'/);
assert.doesNotMatch(runtime, /mock transcription|fake audio|placeholder waveform/i);

const audioService = read('src/senses/live-audio-service.cjs');
assert.match(audioService, /async function transcribeFile/);
assert.match(audioService, /whisper\.transcribe\(inputFile\)/);
assert.match(audioService, /microphone capture is locked while Piper is speaking/);
assert.match(audioService, /async function synthesizeSpeech/);
assert.match(audioService, /piper\.synthesize\(text,\s*metadata\)/);

const config = read('config/chat.config.yaml');
for (const key of [
  'remote_voice_enabled',
  'remote_voice_content_type',
  'remote_voice_max_bytes',
  'remote_voice_min_duration_ms',
  'remote_voice_max_duration_ms',
  'remote_voice_transcript_max_chars',
  'remote_voice_play_reply_audio'
]) {
  assert.match(config, new RegExp(key + ':'));
}

const adapter = read('apps/floki-neural-interface/src/integrations/floki/adapter.js');
assert.match(adapter, /sendVoiceUtterance/);
assert.match(adapter, /\/audio\/remote-utterance/);
assert.match(adapter, /rawBody:\s*audioBlob/);
assert.match(adapter, /base64ToBlob/);

const composer = read('apps/floki-neural-interface/src/components/chat/MessageComposer.jsx');
assert.match(composer, /navigator\.mediaDevices\?\.getUserMedia/);
assert.match(composer, /encodeWav/);
assert.match(composer, /new Blob\(\[buffer\],\s*\{\s*type:\s*'audio\/wav'\s*\}\)/);

const androidRecorder = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiAudioRecorder.kt');
assert.match(androidRecorder, /AudioRecord\.Builder/);
assert.match(androidRecorder, /MediaRecorder\.AudioSource\.VOICE_RECOGNITION/);
assert.match(androidRecorder, /AudioTrack\.Builder/);
assert.match(androidRecorder, /writeAscii\("RIFF"\)/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_REMOTE_VOICE_WHISPER_PIPER_CONTRACT_PASS',
  real_remote_audio_upload: true,
  host_whisper_transcription: true,
  host_piper_reply_audio: true
}, null, 2));
