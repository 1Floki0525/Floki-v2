# Floki-v2 Piper Speech Smoke

Batch 12.1 proves Piper can synthesize Floki speech into a WAV file.

This is not speaker playback yet.

The proof:

- uses the local Piper CLI under .floki-tools
- uses the small US English Piper voice
- writes a WAV file under .floki-tools/output/piper-smoke
- verifies the output is non-empty
- verifies RIFF/WAVE headers
- does not open the webcam
- does not record the microphone
- does not play through speakers
- does not call Minecraft

Proof command:

npm run proof:piper-speech-smoke

Expected marker:

FLOKI_V2_PIPER_SPEECH_SMOKE_PASS
