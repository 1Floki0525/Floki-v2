# Training dataset design

Build attributable QLoRA datasets from bounded approved local sources.

## When to use
You are assembling a training dataset for a QLoRA adapter.

## Sources (allowed, attributable)
SOUL constitution, persistent self-model, identity/personality state, belief ledger, approved autobiographical summaries, approved dream lessons, approved engineering memories, Maker feedback, approved RSI candidates, denial-derived lessons, verified reasoning/tool-use traces.

## Rules
- Never ingest secrets, cookies, tokens, keys, unrestricted logs, every transcript, or unfiltered memory dumps.
- Every record carries source type/path/hash/created/approval/purpose/relevance/confidence; deduplicate; enforce YAML min/max lengths and counts; write immutable manifest + SHA-256.
