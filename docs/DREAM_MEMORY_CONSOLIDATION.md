# Dream Memory Consolidation

Stage 12.29 turns saved dream review files into chat-mode memories Floki can recall later.

## Guard

Dream memory consolidation is disabled unless explicitly allowed:

```bash
FLOKI_ALLOW_DREAM_MEMORY_CONSOLIDATION=1 npm run proof:dream-memory-consolidation
```

Without the flag, the module does not read dream TXT/metadata files, write persistent chat memory, or append `dream-memory-index.jsonl`.

## Inputs

The default dream root remains:

```text
/mnt/firstlight-cold-storage/Floki-memory-bank/dreams
```

The module reads:

- `dream-index.jsonl`
- each indexed dream TXT file
- each indexed sidecar metadata JSON file

Tests may inject a temporary `dream_root` under `state/floki/test/...`.

## Memory Writes

Each consolidated dream is written through `createChatMemorySubstrate().rememberLongTerm(...)` with category `dreams`.

Dream memories include:

- title
- remembered summary
- emotional tone
- symbols
- source memories
- source knowledge
- dream TXT file path

Required tags are applied:

- `dream`
- `sleep`
- `rem`
- `consolidation`
- `date`
- `date:YYYY-MM-DD`
- `rem_cycle:N`

Dream memories speak from first-person continuity, for example: `I dreamed...`.

## Index

The consolidation index is appended at:

```text
/mnt/firstlight-cold-storage/Floki-memory-bank/dreams/dream-memory-index.jsonl
```

The original dream TXT file is never overwritten.

## Report

The latest report is written to:

```text
.floki-tools/output/dream-memory-consolidation/latest-dream-memory-consolidation.json
```

Reports include whether cold storage was used, how many dream files were read, how many persistent memories were written, and whether chat mode remained isolated from game mode.
