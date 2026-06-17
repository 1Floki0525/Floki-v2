# Floki-v2 Hippocampus

Stage: production foundation module.

The hippocampus is Floki-v2's persistent memory system.

It writes safe summarized memories, preserves provenance, recalls deterministic matches, and consolidates important short-term memories into longer-lived streams.

## Real responsibility

The hippocampus handles memory.

It does not speak, decide goals, call models, move a body, or touch Minecraft.

## Inputs

- validated brain events
- safe memory record input
- deterministic recall queries

## Outputs

- `memory_write`
- `memory_recall`
- `failure`

## State reads

- `state/floki/memories/short-term.jsonl`
- `state/floki/memories/episodic.jsonl`
- `state/floki/memories/semantic.jsonl`
- `state/floki/memories/autobiographical.jsonl`

## State writes

- `state/floki/memories/short-term.jsonl`
- `state/floki/memories/episodic.jsonl`
- `state/floki/memories/semantic.jsonl`
- `state/floki/memories/autobiographical.jsonl`
- `state/floki/diagnostics.jsonl`

## Memory streams

- `short_term`
- `episodic`
- `semantic`
- `autobiographical`

## Failure modes

- `HIPPOCAMPUS_INVALID_EVENT`
- `HIPPOCAMPUS_UNSAFE_MEMORY_RECORD`
- `HIPPOCAMPUS_WRITE_FAILED`
- `HIPPOCAMPUS_RECALL_FAILED`
- `HIPPOCAMPUS_CONSOLIDATION_FAILED`

## Forbidden behavior

The hippocampus must never:

- produce speech
- call qwen3.5:4b
- call qwen3-vl:4b
- store raw private reasoning
- start Minecraft
- start PaperMC
- move a body
- fake success

Broca is the only module that may produce user-visible speech.
