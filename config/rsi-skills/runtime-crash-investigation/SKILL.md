# Runtime crash investigation

Diagnose a chat-local runtime crash or watchdog failure from logs and ownership.

## When to use
The authoritative chat runtime crashed, restarted unexpectedly, or the watchdog reported a dead worker.

## Steps
1. `read_log_window` on the worker/runtime logs (tail first).
2. Check process ownership via `src/runtime/chat-local-supervisor-lease.cjs` (lease holder) and `chat-local-cleanup-ownership.cjs`.
3. Reproduce the failing path with the matching contract test before changing code.
4. Confirm the watchdog classifies expected SIGTERM as not-a-failure (see watchdog resilience test).

## Rules
- RSI failures must never terminate or corrupt the authoritative chat runtime.
- Do not introduce a second backend; chat.local is the single runtime.
