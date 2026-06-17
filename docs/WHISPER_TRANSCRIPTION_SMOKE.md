# Floki-v2 Whisper Transcription Proof

Batch 12.5 adds guarded Whisper transcription over the latest recorded microphone WAV.

Normal npm test only runs the guard proof. It does not transcribe user audio.

Manual transcription proof:

npm run proof:whisper-transcription

That command sets:

FLOKI_ALLOW_WHISPER_TRANSCRIPTION=1

The proof uses the latest WAV from:

.floki-tools/input/microphone-smoke/

It writes the latest report to:

.floki-tools/output/whisper-smoke/latest-whisper-transcription.json

The proof:

- uses local whisper.cpp
- uses the local small.en Whisper model by default
- transcribes the latest microphone WAV
- reports the transcribed text
- does not record microphone audio
- does not run VAD analysis
- does not run YOLO inference
- does not run Piper speech
- does not play speaker audio
- does not call Minecraft

Optional input override:

FLOKI_WHISPER_INPUT=/path/to/file.wav npm run proof:whisper-transcription

Optional model override:

FLOKI_WHISPER_MODEL_SIZE=tiny npm run proof:whisper-transcription
FLOKI_WHISPER_MODEL_SIZE=small npm run proof:whisper-transcription

Expected guard marker:

FLOKI_V2_WHISPER_TRANSCRIPTION_GUARD_PASS

Expected manual marker:

FLOKI_V2_WHISPER_TRANSCRIPTION_PASS
