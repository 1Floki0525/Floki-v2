# Floki Neural Interface

Native Electron interface for the local Floki-v2 runtime.

## Launch

From the Floki-v2 repository root:

```bash
bin/floki-start.sh chat.local
```

The command starts the existing sleep scheduler and webcam vision services, builds the React renderer when needed, and opens the interface inside Electron. It does not open an external browser.

## Integration

The Electron main process imports Floki-v2's existing CommonJS modules directly. The renderer receives a narrow context-isolated IPC API through `electron/preload.cjs`.

Connected views include:

- typed Floki chat and public transcript
- cognition latency events
- webcam vision status and latest private observation summary
- persistent affect state
- awake/sleep/REM lifecycle state
- safe diagnostics and neural event stream
- dream and REM records found in Floki state
- service controls and log opening

Model identity remains owned exclusively by the Floki YAML configuration.
