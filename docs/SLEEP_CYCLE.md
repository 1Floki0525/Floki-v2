# Sleep Cycle

Stage marker: `FLOKI_V2_SLEEP_CYCLE_CONTRACT_PASS`

The sleep cycle is chat-mode memory/autonomy only. It does not start game mode,
Minecraft, body movement, microphone capture, speaker playback, webcam vision,
or world simulation.

The scheduler is guarded by `FLOKI_ALLOW_SLEEP_CYCLE=1`. Without that flag,
`runSleepCycleTick()` does not write state, append events, call the dream
engine, or touch cold storage.

Defaults:

- Timezone: `America/Toronto`
- Sleep window: `23:00` to `07:00`
- Idle resume: `120` seconds

Environment overrides:

- `FLOKI_SLEEP_START_HHMM=23:00`
- `FLOKI_SLEEP_END_HHMM=07:00`
- `FLOKI_SLEEP_TIMEZONE=America/Toronto`
- `FLOKI_SLEEP_IDLE_RESUME_SECONDS=120`
- `FLOKI_SLEEP_TEST_NOW=<ISO timestamp>` for deterministic proof runs

For an eight-hour window, the default REM plan is approximately:

- REM 1: 00:30
- REM 2: 02:00
- REM 3: 03:30
- REM 4: 05:00
- REM 5: 06:20

Persistent sleep state lives under:

```text
state/floki/chat/sleep/sleep-cycle-state.json
state/floki/chat/sleep/sleep-events.jsonl
```

Each due REM cycle calls the dream engine once. If the dream engine fails or is
not explicitly allowed when a live REM dream is due, the cycle is marked failed
instead of being faked as success.
