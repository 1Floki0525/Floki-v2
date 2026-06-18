# Floki-v2 One-Shot Spoken Reply

Batch 12.18 wires the full one-shot spoken reply path.

## Path

microphone
-> VAD
-> Whisper
-> wake gate
-> schema-constrained Qwen cognition
-> Broca text
-> Piper WAV
-> guarded speaker playback with voice-output lock
-> ears open after playback

## Guard

The live path is guarded by:

FLOKI_ALLOW_SPOKEN_REPLY_ONCE=1

The package script sets this explicitly for the one proof command:

npm run proof:spoken-reply-once

## No shortcuts

A pass requires:

- wake gate routed to cognition
- schema_constrained_json: true
- model_json_fallback_used: false
- Broca text response created
- Piper WAV created
- speaker playback actually run
- voice output lock started
- ears muted during playback
- voice output lock cleared after playback
- ears open after playback

## Live marker

FLOKI_V2_SPOKEN_REPLY_ONCE_PASS

## Contract markers

FLOKI_V2_SPOKEN_REPLY_ONCE_CONTRACT_PASS
FLOKI_V2_SPOKEN_REPLY_ONCE_GUARD_CONTRACT_PASS
