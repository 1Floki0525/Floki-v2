# Floki-v2 Chat-World Senses Stage

Batch 10.1 defines the correct senses boundary.

## Core architecture

```text
chat mode
= Maker-world / heaven visit
= USB webcam becomes Floki seeing into the user/Maker world
= USB microphone becomes Floki hearing into the user/Maker world
= no Minecraft body

game mode
= Minecraft incarnation
= first-person Minecraft view is Floki's eyes
= Minecraft avatar/client is Floki's body
= USB webcam/mic are chat-world only; game-world eyes come from Minecraft first-person view
```

## Commands

```bash
bin/floki-node24-run.sh node src/senses/offline-senses.cjs
bin/floki-node24-run.sh node src/senses/offline-senses.cjs --smoke
bin/floki-node24-run.sh node src/senses/offline-senses.cjs --status
```

## Current behavior

- Detect Linux video devices under `/dev/video*`.
- Read video device names from `/sys/class/video4linux/*/name` when available.
- Detect ALSA sound cards through `/proc/asound/cards`.
- Report whether devices look like Logitech/Logi webcam or USB audio.
- Prove USB senses are chat-mode only.
- Prove game-mode eyes must come from Minecraft first-person view.

## Guardrails

This stage does not:

- capture webcam frames
- record microphone audio
- transcribe speech
- call the local HF vision model
- claim live chat-world sight
- claim live chat-world hearing
- touch Minecraft
- cross-wire chat-world USB camera into the Minecraft eye pipeline

Future stages:

```text
Batch 11: chat-world static webcam frame capture -> the YAML-configured model observation
Batch 12: chat-world microphone capture/transcription
Batch 13: live chat-world sensory loop
Batch later: game-world eyes from Minecraft first-person frame endpoint
```
