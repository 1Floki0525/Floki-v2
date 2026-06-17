# Floki-v2 Chat Toolchain Readiness

Batch 12.0 proves the local chat embodiment toolchain is installed.

This is readiness only. It does not open the webcam. It does not record microphone audio. It does not transcribe audio. It does not run YOLO inference. It does not run Piper speech.

Checked local tools:

- whisper.cpp CLI
- whisper tiny.en model
- whisper small.en model
- Piper CLI
- Piper tiny voice
- Piper small voice
- Piper med voice
- Piper large voice
- Silero VAD Python import
- Ultralytics YOLO Python import
- local YOLO yolo11n.pt model

Local runtime files live under:

.floki-tools/

That directory is not committed.

Proof command:

npm run proof:chat-toolchain-readiness

Expected marker:

FLOKI_V2_CHAT_TOOLCHAIN_READINESS_PASS
