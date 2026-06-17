# Floki-v2 Memory-Aware Hearing-to-Cognition

Batch 12.10 wires persistent chat memory into hearing-to-cognition.

The bridge now performs:

heard text -> short-term memory -> emotional reinforcement -> consolidation -> recall context -> cognition

## Persistent memory usage

The bridge writes the heard utterance into persistent short-term chat memory.

Important or emotionally salient short-term memories can consolidate into long-term memory.

## Emotional reinforcement

The bridge reinforces a conversation habit target:

conversation_habit:respond_when_addressed_by_wake_phrase

This gives later stages a bounded growth signal for chat behavior.

## Recall context

Before cognition, the bridge builds recall context from:

- short-term memories
- long-term memories
- current emotional scores
- reinforced targets

That context is passed into frontal cognition as persistent_chat_memory and emotional_reinforcement.

## Output marker

Manual hearing-to-cognition now returns:

FLOKI_V2_MEMORY_AWARE_HEARING_TO_COGNITION_PASS

The deterministic contract test returns:

FLOKI_V2_MEMORY_AWARE_HEARING_TO_COGNITION_CONTRACT_PASS
