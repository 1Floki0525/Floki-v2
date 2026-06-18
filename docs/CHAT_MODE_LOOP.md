# Floki-v2 Chat Mode Loop

Stage 12.19 adds the bounded continuous chat loop for chat mode only.

## Required Path

The loop repeats the already-proven one-shot spoken reply path:

microphone -> VAD -> Whisper -> wake gate -> schema-constrained Qwen cognition -> Broca -> Piper WAV -> guarded speaker playback

Each turn checks the voice output lock before recording. If Floki is speaking, the loop does not start microphone capture, VAD, Whisper, Qwen, Broca, Piper, or speaker playback for the next turn.

## Guard

The loop is blocked unless this environment variable is set:

```bash
FLOKI_ALLOW_CHAT_MODE_LOOP=1
```

Proof runs are bounded. The default is one turn, and `FLOKI_CHAT_MODE_LOOP_TURNS` is capped for proof safety.

## Reports

Live loop proof writes:

```text
.floki-tools/output/chat-mode-loop/latest-chat-mode-loop.json
```

Contract tests write isolated reports under `state/floki/test/...` or disable report writing.

## Proof Commands

```bash
npm run proof:chat-mode-loop-guard
npm run proof:chat-mode-loop
```

Bounded live proof:

```bash
FLOKI_CHAT_MODE_LOOP_TURNS=1 FLOKI_HEARING_CAPTURE_SECONDS=6 npm run proof:chat-mode-loop
```

Known-good real capture replay proof:

```bash
FLOKI_CHAT_MODE_LOOP_TURNS=1 FLOKI_HEARING_INPUT_WAV=/media/binary-god/1tb-ssd/Floki-v2/.floki-tools/input/microphone-smoke/microphone_smoke_20260617204048.wav npm run proof:chat-mode-loop
```

Replay reports must set `microphone_capture_replay_used:true` and must not claim `microphone_recorded_now:true`.

## Required Markers

- `FLOKI_V2_CHAT_MODE_LOOP_CONTRACT_PASS`
- `FLOKI_V2_CHAT_MODE_LOOP_GUARD_CONTRACT_PASS`
- `FLOKI_V2_KNOWN_AUDIO_WHISPER_REGRESSION_PASS`
- `FLOKI_V2_CHAT_MODE_LOOP_PASS`

## Non-Negotiables

- Chat mode only.
- Ears are normally on: Floki should keep listening and transcribing ambient speech like a normal person hears the room.
- No microphone capture while the voice output lock is active.
- No Qwen call or spoken reply unless the wake gate routes a `Hey Floki` request.
- Background speech may be heard/transcribed, but it must not route to cognition/reply without the wake phrase.
- No speaker playback unless Broca and Piper produced real output.
- No model JSON fallback as success.
- No generated runtime artifacts committed.
