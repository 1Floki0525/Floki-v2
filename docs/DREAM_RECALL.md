# Dream Recall

Stage 12.30 makes saved dream memories available to chat cognition.

When the user asks questions such as:

- `Hey Floki, did you dream last night?`
- `Hey Floki, what did you dream about?`
- `Hey Floki, do you remember your dreams?`
- `Hey Floki, what did your last dream mean to you?`

the hearing-to-cognition bridge retrieves compact dream context from persistent chat memory and the cold-storage dream-memory index.

## Retrieval

Dream recall reads:

- long-term chat memories tagged `dream`, `sleep`, or `rem`
- `dream-memory-index.jsonl` under the dream root

The default dream root remains:

```text
/mnt/firstlight-cold-storage/Floki-memory-bank/dreams
```

## Frontal Prompt Contract

Frontal receives `dream_memory_context` inside `persistent_chat_memory`.

The prompt tells the model:

- use dream memories as self-continuity
- speak in first person
- be honest if no dreams are saved yet
- answer from saved dream files and memory entries when they exist
- never invent dreams

## Boundaries

Dream recall is chat-mode memory only. It does not start game mode, body mode, Minecraft mode, world simulation, or physical sleep claims.
