# Sleep Wake Resume

Stage marker: `FLOKI_V2_SLEEP_WAKE_RESUME_CONTRACT_PASS`

Wake interruption is chat-mode only. It does not start game mode, Minecraft,
body movement, microphone capture outside the existing chat path, or world
simulation.

When `FLOKI_ALLOW_SLEEP_CYCLE=1` and a wake-gated spoken reply routes to
cognition during the configured sleep window, the spoken reply path records a
sleep interruption through `recordWakeActivityIfSleeping()`.

The active sleep cycle is paused, not restarted. The state keeps:

- the same `current_sleep_date`
- the same sleep window start/end
- already completed REM cycles
- pending REM cycles still pending
- `last_user_activity_at`

After 120 seconds of idle time by default, `runSleepCycleTick()` resumes the
same sleep cycle. If the sleep window has ended, the cycle ends instead of
generating a new dream after 7 AM.
