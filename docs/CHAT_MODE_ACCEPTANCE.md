# Floki-v2 Chat Mode Acceptance

Stage 12.24 adds the final chat-mode acceptance proof.

## Command

```bash
npm run proof:chat-mode-acceptance
```

Required marker:

```text
FLOKI_V2_CHAT_MODE_ACCEPTANCE_PASS
```

## What It Runs

- chat mode status
- live microphone capture
- VAD on the live microphone capture
- one-shot spoken reply using the known wake-gated audio fixture unless overridden
- bounded chat mode loop using the known wake-gated audio fixture unless overridden
- self-echo regression
- full `npm test`

The acceptance report includes both the current live microphone capture path and the known-good audio path used for deterministic wake-gated spoken proof.

## Required Fields

The final report includes:

- `capture_file`
- `whisper_report_file`
- `hearing_report_file`
- `piper_wav_output_file`
- `spoken_reply_report_file`
- `microphone_recorded_now`
- `vad_audio_analysis_run_now`
- `whisper_transcription_run_now`
- `wake_gate_checked_now`
- `wake_routed_to_cognition`
- `qwen_cognition_run_now`
- `schema_constrained_json`
- `model_json_fallback_used`
- `persistent_memory_used`
- `emotional_reinforcement_used`
- `broca_enabled_now`
- `piper_speech_run_now`
- `piper_wav_created_now`
- `speaker_playback_run_now`
- `voice_output_lock_started`
- `ears_muted_during_playback`
- `voice_output_lock_cleared_after_playback`
- `ears_open_after_playback`
- `self_echo_blocked`
- `background_speech_ignored`
- `chat_mode_only`
- `game_mode_started`

## Scope

Chat mode only. No game mode start, no body movement, no world interaction.
