# Dream Status

Stage 12.31 exposes sleep and dream state for chat mode.

It reports:

- current local time
- 11 PM to 7 AM sleep window
- whether Floki is currently sleeping
- whether sleep is interrupted
- seconds remaining before the 120-second idle resume
- REM cycles completed and pending
- latest dream file and title
- dream-memory index status
- cold-storage dream root availability
- chat mode only and game mode false

Default dream root:

```text
/mnt/firstlight-cold-storage/Floki-memory-bank/dreams
```

The status command is read-only. It does not generate dreams, call Qwen, write memories, start Minecraft, or start game mode.
