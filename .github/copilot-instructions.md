# Floki-v2 Copilot Instructions

## Runtime setup

- Use Node 24 for every `node`/`npm` command in this repo. Either activate it first with `source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 24 >/dev/null` or run commands through `bash bin/floki-node24-run.sh ...`.
- The tracked config files are templates: `config/chat.config.yaml.temp` and `config/game.config.yaml.temp`. The live runtime reads the ignored working copies `config/chat.config.yaml` and `config/game.config.yaml`.

## Build, test, and lint commands

- Full repo build: `npm run build`
  - This runs `bin/floki-build.sh`, which builds `apps/floki-neural-interface` and then runs its integration contracts.
- Full repo test suite: `npm test`
- Chat-local scoped suite: `npm run test:chat-local`
- Live extended suite: `npm run test:live`
- Run one root contract test: `bash bin/floki-node24-run.sh node tests/<name>-contract-test.cjs`
- Build only the Electron interface: `bash bin/floki-node24-run.sh npm --prefix apps/floki-neural-interface run build`
- Lint the Electron interface: `bash bin/floki-node24-run.sh npm --prefix apps/floki-neural-interface run lint`
- Run one interface test directly: `bash bin/floki-node24-run.sh node apps/floki-neural-interface/tests/<name>.cjs`

There is no root lint script; ESLint is configured only for `apps/floki-neural-interface`.

## High-level architecture

- The active `chat.local` backend is not `src/brain/floki-brain.cjs`; that file is still a scaffold placeholder. The real runtime path is:
  - `src/runtime/chat-local-runtime.cjs` - lifecycle coordinator, local HTTP/API surface, transcript/status wiring, vision/audio/self-improvement integration
  - `src/chat/floki-chat.cjs` - chat-mode runtime entry point
  - `brain/core_brain/index.cjs` - assembles the authoritative module graph for chat/game modes
- Brain modules live under `brain/*/index.cjs`. The important production roles are:
  - `thalamus` routes validated brain events
  - `hippocampus` writes and recalls persistent memory streams under `state/floki/memories/*.jsonl`
  - `frontal` handles cognition
  - `broca` is the only module allowed to produce user-facing speech
- Perception is split into dedicated services under `src/senses/*` and `src/vision/*`. These services write runtime files (status, heartbeat, frames, observations, detections) that the backend and UI consume.
- `apps/floki-neural-interface` is a presentation client for the single authoritative backend runtime. It should not become a second brain or separate memory/speech system.
- Sleep/dream flow lives under `src/chat/*` (`sleep-cycle`, `manual-nap`, `dream-*`), and the self-improvement / RSI subsystem lives under `src/self-improvement/*` and is surfaced through the interface API.

## Key conventions

- YAML is the source of truth for adjustable runtime behavior. Pull config through `src/config/floki-config.cjs`; do not hardcode model names, ports, device paths, thresholds, schedules, or storage roots in production code.
- The YAML parser in `src/config/yaml-lite.cjs` supports nested maps only. Do not introduce YAML arrays into Floki config files.
- Preserve mode and reality boundaries:
  - chat webcam vision is not game vision
  - `pineal_mind_eye` is inner/dream vision, not external sight
  - Electron owns presentation only; the backend owns memory, senses, transcript, sleep state, and speech lifecycle
- Keep public and private streams separate. Public transcript/speech must never contain private reasoning markers (`<think>`, `chain_of_thought`, `scratchpad`, etc.). Use the existing transcript helpers and Broca/release-gate flow instead of bypassing them.
- Follow the repository's contract style when editing brain/runtime modules: explicit module contracts, structured failure markers/codes, append-only JSONL diagnostics, and CommonJS `.cjs` files.
- When docs conflict, prefer the live behavior encoded in `tests/`, `src/runtime/`, `src/chat/`, `src/vision/`, `src/senses/`, and `brain/core_brain/` over older scaffold-only placeholders.
