# Dream Engine

Stage marker: `FLOKI_V2_DREAM_ENGINE_CONTRACT_PASS`

The dream engine is chat-mode memory/autonomy only. It does not start game mode,
Minecraft, body movement, microphone capture, speaker playback, webcam vision,
or world simulation.

Dream generation is guarded by `FLOKI_ALLOW_DREAM_ENGINE=1`. Without that flag,
`runDreamEngineOnce()` returns a blocked report and performs no model call, file
write, memory write, or dream-index append.

The production dream root defaults to:

```text
/mnt/firstlight-cold-storage/Floki-memory-bank/dreams
```

Tests may inject a temporary `dream_root` under `state/floki/test/...`; the
production default remains cold storage.

Dream files are written as:

```text
<dream-root>/YYYY/MM/DD/rem-cycle-01_<timestamp>_<short-safe-title>.txt
<dream-root>/YYYY/MM/DD/rem-cycle-01_<timestamp>_<short-safe-title>.json
<dream-root>/dream-index.jsonl
```

The model path uses schema-constrained JSON via the existing Ollama client.
Contract tests may inject a deterministic generator, but live proof through
`npm run proof:dream-engine` calls the real intended model path and fails
honestly if valid JSON is not produced.

Dream text is human-readable and includes title, date/time, REM cycle number,
sleep window, sources used, dream story, emotional tone, memory consolidation
notes, and what I may remember from the dream.

Dream JSON is safe-summary-only and rejects private reasoning markers and
third-person self-narration such as `Floki dreamed...`.
