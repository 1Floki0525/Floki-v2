# Floki-v2 Voice Output Lock

Batch 12.16 adds the voice output lock and ears-muted guard.

## Rule

When Floki is speaking, ears are muted.

That means the hearing loop must not run:

- microphone capture
- VAD
- Whisper
- Qwen
- Broca
- Piper
- speaker playback

The wake gate must also reject any transcript while the voice output lock is active.

## Why this exists

Before speaker playback is allowed, Floki needs a source-level self-echo guard.

The fix is not a fallback. It is a shared persistent lock used by hearing and wake-gating code.

## Proof marker

FLOKI_V2_VOICE_OUTPUT_LOCK_CONTRACT_PASS
