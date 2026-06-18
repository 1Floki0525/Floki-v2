# Floki-v2 Chat Mode Status

Stage 12.21 adds a read-only chat mode status command.

## Command

```bash
npm run proof:chat-mode-status
```

Required marker:

```text
FLOKI_V2_CHAT_MODE_STATUS_PASS
```

## Status Scope

The status command reports:

- microphone readiness and the always-listening transcription expectation
- VAD readiness
- Whisper readiness
- Qwen cognition provider/model/config
- Broca readiness
- Piper voice model/config
- speaker playback guard state
- voice output lock state
- wake word config
- persistent chat memory substrate paths
- emotion and reinforcement state summary
- personality and identity state summary
- latest hearing, spoken reply, and loop reports
- chat mode active/inactive state
- game mode explicitly out of scope

## Non-Negotiables

- Read-only status only.
- Do not record the microphone.
- Do not run Whisper, Qwen, Broca, Piper, or speaker playback.
- Do not start game mode.
- Chat mode ears are normally on and may transcribe everything Floki hears, but replies remain wake-gated.
- The microphone should only be unavailable while Floki is speaking under the voice output lock.
