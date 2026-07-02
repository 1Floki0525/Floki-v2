# Audio pipeline debugging

Debug hearing/speech (Whisper/VAD/Piper) without breaking the chat loop.

## When to use
Hearing or speech fails, or training resource mode must suspend/restore the audio loop.

## Rules
- During training/sleep, the Whisper/VAD loop and speech must be suspended, then restored on wake.
- Use the guard smoke entrypoints (FLOKI_ALLOW_* env) to exercise real code paths.
