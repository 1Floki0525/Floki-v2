# Floki-v2 Offline Senses Stage

Batch 10 adds the guarded offline senses entrypoint for a USB webcam/mic.

## Commands

```bash
bin/floki-start.sh senses
bin/floki-start.sh senses-smoke
bin/floki-start.sh senses-status
```

## Current behavior

- Detect Linux video devices under `/dev/video*`.
- Read video device names from `/sys/class/video4linux/*/name` when available.
- Detect ALSA sound cards through `/proc/asound/cards`.
- Report whether devices look like Logitech/Logi webcam or USB audio.

## Guardrails

This stage does not:

- capture webcam frames
- record microphone audio
- transcribe speech
- call qwen3-vl
- claim live sight
- claim live hearing
- touch Minecraft

Offline senses are separate from Minecraft game senses.

Future stages:

```text
Batch 11: static webcam frame capture -> qwen3-vl:4b observation
Batch 12: microphone capture/transcription
Batch 13: live offline sensory loop
```
