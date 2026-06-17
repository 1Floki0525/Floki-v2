# Floki-v2 Wake Word Gate

Batch 12.11 adds the chat-mode wake-word gate.

Required wake phrase:

hey Floki

The gate applies to both spoken and typed input.

## Routed examples

These become direct requests:

- hey Floki, can you hear me?
- HEY FLOKI remember this
- Hey Floki tell me what you feel

The wake phrase is stripped before cognition.

Example:

hey Floki, tell me what you remember

becomes:

tell me what you remember

## Ignored examples

These do not become direct requests:

- Floki can you hear me?
- can you hear me?
- background speech
- empty input

Unaddressed background speech may be remembered later as background context, but it must not trigger a direct reply.

## Self-echo blocking

If Floki is speaking, ears are treated as muted.

Input from self_voice is rejected even if it contains the wake phrase.

This prevents Piper speaker output from being treated as user speech.

## Proof marker

FLOKI_V2_WAKE_WORD_GATE_PASS
