# Floki-v2 Chat Memory Substrate

Batch 12.9 creates the persistent chat-mode memory substrate.

This is the first concrete layer for human-like memory behavior in chat mode.

## Storage

Default storage lives under:

state/floki/chat/memory/

Files:

- short-term.jsonl
- long-term.jsonl
- emotional-scores.json
- reinforcement-events.jsonl
- consolidation-log.jsonl
- latest-recall-context.json

## Short-term memory

Short-term memory stores recent chat experience:

- recent user utterances
- recent Floki responses
- current conversation context
- recent affect
- immediate goals
- important sensory observations

Short-term memory is persistent JSONL, not an in-memory-only scratchpad.

## Long-term memory

Long-term memory stores durable continuity:

- autobiographical memories
- semantic facts
- relationship history
- beliefs
- biases
- preferences
- likes
- dislikes
- hopes
- dreams
- goals
- skills
- emotional lessons

## Consolidation

Important short-term memories can be promoted into long-term memory.

A memory may consolidate when it has:

- high importance
- strong emotion
- identity relevance
- relationship relevance
- belief relevance
- preference relevance
- hope or dream relevance
- repeated growth value

## Emotional reinforcement

Emotion scores are persisted.

The scoring range is -1 to 1.

Emotional reinforcement can strengthen or weaken a target such as:

- belief
- bias
- preference
- trust expectation
- avoidance pattern
- curiosity pattern
- hope pattern
- social habit
- autonomy choice

This does not replace cognition. It creates a bounded growth signal that later cognition can use.

## Recall context

Before cognition, the memory substrate can build recall context from:

- relevant short-term memories
- relevant long-term memories
- current emotional scores
- reinforced targets

Expected proof marker:

FLOKI_V2_CHAT_MEMORY_SUBSTRATE_PASS
