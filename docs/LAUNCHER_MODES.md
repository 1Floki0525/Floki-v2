# Floki-v2 Runtime and Client Commands

Floki-v2 has one system lifecycle authority:

```bash
bin/floki-runtime.sh start
bin/floki-runtime.sh status
bin/floki-runtime.sh reset
bin/floki-runtime.sh stop
```

`reset` performs the complete verified stop-and-start cycle so source or
configuration changes take effect without issuing two commands.

## Local desktop client

The Electron client is presentation only. It requires the shared runtime to
already be ready and never creates or owns a second brain:

```bash
bin/floki-app.sh
```

## Remote clients

The website and APK connect to the same shared runtime. They do not start,
stop, reset, or replace Floki's brain, identity, memory, senses, sleep system,
or RSI workers.

## Developer proofs

Read-only or guarded developer proofs call their module entrypoints directly:

```bash
npm run proof:chat-shell
npm run proof:game-entrypoint
npm run proof:senses
npm run proof:core-brain-status
```

The retired multi-mode launcher is intentionally absent. Runtime lifecycle
must never be reintroduced outside `bin/floki-runtime.sh`.
