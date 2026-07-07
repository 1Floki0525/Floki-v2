# Configuration transport repair

Add or fix a YAML-driven setting end to end through the chat config layer.

## When to use
A setting must become adjustable, or a value is hardcoded and a test (e.g. `no-hardcoded-runtime-config-contract-test.cjs`) is failing.

## Transport path (authoritative)
1. Add the key under `self_improvement:` in **config/chat.config.yaml.temp** (public template, portable placeholder paths only).
2. Whitelist it in `getSelfImprovementConfig()` in **src/config/floki-config.cjs** using `stringValue`/`numberValue`/`booleanValue` — keys not whitelisted are silently dropped.
3. If the sandbox/agent needs it, surface it in `agentConfig()` in **src/self-improvement/sandbox.cjs**.
4. Read it anywhere via `loadSelfImprovementConfig().<key>` (src/self-improvement/config.cjs).
5. The private host file **config/chat.config.yaml** must gain the key too — use `bin/floki-migrate-chat-config.cjs` (non-destructive) on the host; in CI it is regenerated from the template by `bin/floki-prepare-ci-config.cjs`.

## Rules
- yaml-lite has NO arrays — encode lists as pipe-delimited strings and `.split('|')` at the consumer.
- Never read, write, or reference config/game.config.yaml(.temp).
- Use `find_config_transport_path(key)` to confirm template + loader + consumers are all present.

## Verification
`node -e "require('./src/config/floki-config.cjs').getSelfImprovementConfig('chat').<key>"` then the affected contract test.
