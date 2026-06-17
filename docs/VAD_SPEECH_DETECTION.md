# Floki-v2 VAD Speech Detection Proof

Batch 12.4 adds guarded Silero VAD speech detection over a recorded microphone WAV.

Normal npm test only runs the guard proof. It does not analyze user audio.

Manual VAD proof:

npm run proof:vad-speech-detection

That command sets:

FLOKI_ALLOW_VAD_ANALYSIS=1

The proof uses the latest WAV from:

.floki-tools/input/microphone-smoke/

It writes the latest VAD report to:

.floki-tools/output/vad-smoke/latest-vad-speech-detection.json

The VAD proof:

- loads Silero VAD from the local chat embodiment Python venv
- reads the latest microphone WAV
- detects speech timestamps
- reports speech segment count
- does not record microphone audio
- does not run Whisper transcription
- does not run YOLO inference
- does not run Piper speech
- does not play speaker audio
- does not call Minecraft

Optional input override:

FLOKI_VAD_INPUT=/path/to/file.wav npm run proof:vad-speech-detection

Expected guard marker:

FLOKI_V2_VAD_SPEECH_DETECTION_GUARD_PASS

Expected manual marker:

FLOKI_V2_VAD_SPEECH_DETECTION_PASS
