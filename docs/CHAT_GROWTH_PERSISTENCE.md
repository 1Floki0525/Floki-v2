# Floki-v2 Chat Growth Persistence

Stage 12.22 proves chat-mode growth is persistent, not just test-scoped.

## Commands

```bash
npm run proof:chat-growth-persistence-guard
npm run proof:chat-growth-persistence
```

Required markers:

```text
FLOKI_V2_CHAT_GROWTH_PERSISTENCE_GUARD_PASS
FLOKI_V2_CHAT_GROWTH_PERSISTENCE_CONTRACT_PASS
FLOKI_V2_CHAT_GROWTH_PERSISTENCE_PASS
```

## Live Proof Input

The live proof can use a hearing report from a real hearing run. If no report is supplied, it uses the known wake-gated audio fixture:

```text
.floki-tools/input/microphone-smoke/microphone_smoke_20260617204048.wav
```

The fixture path is not committed. When used, Stage 12.22 runs real Whisper transcription on that WAV and builds a hearing report from the real transcript.

## Persistence Surface

The live proof writes to:

- `state/floki/chat/memory/short-term.jsonl`
- `state/floki/chat/memory/long-term.jsonl`
- `state/floki/chat/memory/reinforcement-events.jsonl`
- `state/floki/chat/memory/consolidation-log.jsonl`
- `state/floki/chat/memory/latest-recall-context.json`
- `state/floki/affect.json`
- `state/floki/personality.json`
- `state/floki/identity.json`

Contract tests use isolated paths under `state/floki/test/...` and must not overwrite live latest reports.

## Guarantees

- Wake-gated utterance writes short-term chat memory.
- Consolidation can promote that memory to long-term chat memory.
- Recall returns long-term context before cognition.
- Emotional reinforcement writes a target event and updated score.
- Affect, personality, and identity state persist to real chat-mode files during live proof.
- Qwen must run with schema-constrained JSON; deterministic JSON fallback is not a pass.
- Broca and Piper may run for proof output, but speaker playback stays off.
- Chat mode only.
