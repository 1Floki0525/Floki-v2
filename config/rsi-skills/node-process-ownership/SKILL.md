# Node process ownership

Reason about which process owns the runtime, worker, and sandbox to avoid double backends.

## When to use
A run kind, abort, or restart touches process lifecycle, or two backends could appear.

## Key facts
- The worker is a long-running daemon (`serviceLoop`); manual runs wake it via SIGUSR1.
- The supervisor lease guarantees a single authoritative runtime; never start a second.
- Run IDs are assigned by the snapshot step (`newRunId`), not by the request.

## Rules
- Verify exact process command lines before terminating anything.
- chat.local is the single authoritative backend.
