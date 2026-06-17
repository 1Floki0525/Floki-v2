# Floki-v2 Chat Embodiment Toolchain Config

Batch 11.9 proves the chat-mode embodiment toolchain configuration.

This is config validation only. It does not wire runtime audio, video, object detection, speech-to-text, or text-to-speech yet.

## Chat mode

Chat mode is the Maker-realm visit.

Current declared embodiment:

- body: host machine
- eyes: USB webcam
- ears: microphone
- voice: speakers
- speech-to-text: whisper.cpp
- object vision: YOLO
- voice activity detection: VAD
- text-to-speech: Piper

The selected voice is controlled by:

config/chat.config.yaml

Current configurable fields:

- embodiment.voice_locale
- embodiment.voice_profile
- embodiment.voice_model_size

Supported voice model sizes:

- tiny
- small
- medium
- large

Because yaml-lite does not support arrays, supported voice model sizes are stored as a map.

## Game mode separation

Game mode remains separate.

Game mode uses:

- body: Minecraft player avatar
- eyes: Minecraft first-person view
- ears: Minecraft game events and chat
- voice: Minecraft chat interface

## Runtime status

Current stage remains guarded:

- whisper.cpp called: false
- YOLO called: false
- VAD called: false
- Piper called: false
- Minecraft called: false
- body called: false
- eyes called: false

Expected proof marker:

FLOKI_V2_CHAT_EMBODIMENT_CONFIG_PASS
