# Floki-v2 Self-Echo Regression

Stage 12.20 hardens chat mode against Floki hearing himself.

## Covered Paths

- Direct microphone capture refuses to record while the voice output lock is active.
- Wake-gated hearing refuses to route a transcript while the voice output lock is active.
- A simulated transcript containing `Hey Floki` is blocked during muted ears.
- Speaker playback starts the voice output lock before playback.
- Speaker playback clears the lock afterward.
- The continuous chat loop does not start the next capture while the lock is active.
- Muted-ears paths do not run Qwen, Broca, Piper, or speaker playback.

## Required Proof

```bash
npm run proof:self-echo-regression
```

Required marker:

```text
FLOKI_V2_SELF_ECHO_REGRESSION_PASS
```

## Non-Negotiables

- Chat mode only.
- No microphone capture while Floki is speaking.
- No wake routing while the voice output lock is active.
- No Qwen, Broca, or Piper during muted-ears paths.
- No fake pass: injected runners are only used to inspect boundaries and lock state.
