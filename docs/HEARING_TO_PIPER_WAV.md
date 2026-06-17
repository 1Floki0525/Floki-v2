# Floki-v2 Hearing to Piper WAV

Batch 12.15 wires Broca text into Piper WAV synthesis.

## Required path

wake-gated transcript
-> memory-aware schema-constrained cognition
-> Broca text response
-> Piper WAV file

## Non-negotiable proof rules

This stage must not play speakers.

A live pass requires:

- cognition_type: model_response_summary
- schema_constrained_json: true
- model_json_fallback_used: false
- broca_enabled_now: true
- broca_text_response_created_now: true
- piper_speech_run_now: true
- piper_wav_created_now: true
- speaker_playback_run_now: false

## Live marker

FLOKI_V2_WAKE_GATED_MEMORY_AWARE_HEARING_TO_PIPER_WAV_PASS

## Contract marker

FLOKI_V2_HEARING_TO_PIPER_WAV_CONTRACT_PASS
