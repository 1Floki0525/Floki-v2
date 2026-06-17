# Floki-v2 Wake-Gated Hearing-to-Cognition

Batch 12.12 wires the wake-word gate into the hearing-to-cognition bridge.

The bridge now checks the transcript before Qwen cognition.

## Direct request path

Input:

hey Floki, what do you remember?

Wake gate strips:

hey Floki

Cognition receives:

what do you remember?

Then the normal memory-aware hearing-to-cognition bridge runs.

Expected live routed marker:

FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_COGNITION_PASS

## Ignored path

Input:

what do you remember?

No wake phrase means:

- no Qwen call
- no Broca call
- no Piper call
- no speaker playback
- no direct reply

Expected ignored marker:

FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_IGNORED

## Self-echo path

If Floki is speaking, or the transcript is marked self_voice, the bridge blocks it before cognition.

This prevents Piper output from becoming a new user utterance.

## Contract proof marker

FLOKI_V2_WAKE_GATED_HEARING_TO_COGNITION_CONTRACT_PASS
