# Floki-v2 Chat Hearing Loop Proof

Batch 12.6 adds a guarded Maker-realm hearing pipeline.

The pipeline is:

microphone capture -> VAD speech detection -> Whisper transcription

Normal npm test only runs the guard proof. It does not record audio, analyze audio, or transcribe speech.

Manual hearing proof:

npm run proof:chat-hearing-loop

That command sets:

FLOKI_ALLOW_CHAT_HEARING_LOOP=1

The hearing proof:

- records one short microphone WAV
- runs Silero VAD on that exact WAV
- runs whisper.cpp on that exact WAV
- returns heard_text
- writes a report under .floki-tools/output/chat-hearing-loop/
- does not call Qwen
- does not call Broca
- does not run Piper speech
- does not play speaker audio
- does not open the webcam
- does not run YOLO inference
- does not call Minecraft

Optional capture length:

FLOKI_HEARING_CAPTURE_SECONDS=5 npm run proof:chat-hearing-loop

Optional mic device:

FLOKI_MIC_DEVICE=plughw:C615,0 npm run proof:chat-hearing-loop

Optional Whisper model:

FLOKI_WHISPER_MODEL_SIZE=tiny npm run proof:chat-hearing-loop
FLOKI_WHISPER_MODEL_SIZE=small npm run proof:chat-hearing-loop

Expected guard marker:

FLOKI_V2_CHAT_HEARING_LOOP_GUARD_PASS

Expected manual marker:

FLOKI_V2_CHAT_HEARING_LOOP_PASS
