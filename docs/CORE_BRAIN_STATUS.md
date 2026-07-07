# Floki-v2 Core Brain Status

Batch 11.7 adds a safe status/introspection report for the core_brain and its embodiment boundary.

This is read-only introspection. It does not call qwen. It does not call whisper.cpp. It does not call YOLO. It does not call VAD. It does not call Piper. It does not call qwen-vl. It does not enable Minecraft. It does not enable body movement. It does not enable game-world eyes.

Command:

bash bin/floki-node24-run.sh node src/brain/core-brain-status.cjs chat

or:

bash bin/floki-node24-run.sh node src/brain/core-brain-status.cjs game

Proof:

npm run proof:core-brain-status

## Embodiment model

Chat mode is a Maker-realm visit.

In chat mode:

- body: host machine
- eyes: USB webcam
- ears: microphone
- voice: speakers
- planned STT: whisper.cpp
- planned object vision: YOLO
- planned VAD: VAD
- planned TTS: Piper
- voice selection lives in config/chat.config.yaml

Game mode is Floki's Minecraft home-realm incarnation.

In game mode:

- body: Minecraft player avatar
- eyes: Minecraft first-person game view
- ears: Minecraft game events and chat
- voice: Minecraft chat interface
- game mode remains separate from chat mode embodiment

The brain stack is shared. The embodiment stack is separate.

Current boundaries remain:

- Minecraft disabled
- body movement disabled
- game-world eyes disabled
- qwen-vl live vision disabled
- whisper.cpp runtime disabled
- YOLO runtime disabled
- VAD runtime disabled
- Piper runtime disabled
- raw private reasoning storage disabled

Expected proof marker:

FLOKI_V2_CORE_BRAIN_STATUS_PASS
