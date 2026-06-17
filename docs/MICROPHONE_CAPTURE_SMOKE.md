# Floki-v2 Microphone Capture Proof

Batch 12.3 adds guarded microphone capture for Maker-realm hearing.

Normal npm test only runs the guard proof and does not record audio.

Manual microphone proof command:

npm run proof:microphone-capture

That command sets:

FLOKI_ALLOW_MICROPHONE_CAPTURE=1

The capture proof:

- records a short WAV using arecord
- writes the file under .floki-tools/input/microphone-smoke
- verifies the file is non-empty
- verifies RIFF/WAVE headers
- does not run Whisper transcription
- does not run VAD analysis
- does not run YOLO inference
- does not play speaker audio
- does not call Minecraft

Optional device override:

FLOKI_MIC_DEVICE=default npm run proof:microphone-capture

Useful alternatives if default fails:

FLOKI_MIC_DEVICE=hw:C615,0 npm run proof:microphone-capture
FLOKI_MIC_DEVICE=plughw:C615,0 npm run proof:microphone-capture

Expected guard marker:

FLOKI_V2_MICROPHONE_CAPTURE_GUARD_PASS

Expected manual capture marker:

FLOKI_V2_MICROPHONE_CAPTURE_PASS
