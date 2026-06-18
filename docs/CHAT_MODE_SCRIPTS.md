# Floki-v2 Chat Mode Scripts

Stage 12.23 adds user-facing chat-mode scripts.

## Scripts

```bash
bin/floki-chat-start.sh
bin/floki-chat-stop.sh
bin/floki-chat-status.sh
bin/floki-chat-proof.sh
```

Required markers:

```text
FLOKI_V2_CHAT_START_SCRIPT_PASS
FLOKI_V2_CHAT_STOP_SCRIPT_PASS
FLOKI_V2_CHAT_STATUS_SCRIPT_PASS
FLOKI_V2_CHAT_SCRIPTS_CONTRACT_PASS
FLOKI_V2_CHAT_SCRIPTS_GUARD_PASS
```

## Runtime Files

Runtime files live under:

```text
state/floki/chat/runtime/
```

Files:

- `chat-mode-loop.pid`
- `chat-mode-loop.stop`
- `chat-mode-loop.log`

These are local runtime artifacts and must not be committed.

## Safety

- Scripts do not use `set -e`.
- Stop validates that the PID belongs to `floki-chat-start.sh --runner`.
- Stop does not use `pkill` or `killall`.
- Start does not unload Ollama models.
- Proof mode is bounded with `FLOKI_CHAT_MODE_LOOP_TURNS=1` by default.
- Status is read-only and reports loop active state, lock state, latest reports, Qwen model, Piper voice, speaker guard, and latest proof marker.
- Chat mode remains always-listening in intent: ears are open unless Floki is speaking, transcripts are wake-gated for replies.
