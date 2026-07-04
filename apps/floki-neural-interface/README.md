# Floki Neural Interface

The Floki Neural Interface is the native Electron/React client named
`floki.app`.

It connects to the single authoritative shared Floki runtime. It does not
create a second brain, personality, memory store, sensory lifecycle, sleep
system, or RSI process.

## Launch

From the Floki-v2 repository root:

```bash
bin/floki-runtime.sh start
bin/floki-app.sh
```

The runtime must already be ready. `floki.app` does not autostart or own the
runtime. Camera and microphone access remain controlled by the shared runtime,
Floki's awake/sleep state, and the existing YAML settings.

## Connected features

- typed and spoken conversation from one persistent transcript;
- visible transcript continuity across sessions;
- a clear-visible-chat control that preserves memories and private state;
- live webcam frame and observation status;
- person and object detections;
- cognition latency information;
- persistent affect and emotion state;
- awake, sleep, REM, and dream status;
- safe diagnostics and real service controls.

## Authority boundaries

- `bin/floki-runtime.sh` exclusively owns start, stop, reset, restart, and
  status for the complete Floki system.
- Floki-v2 YAML owns adjustable runtime configuration and model identity.
- The shared runtime owns the brain, hearing, vision, memory, sleep lifecycle,
  transcript files, and RSI resource handoffs.
- `floki.app`, the website, and the APK own presentation and user interaction
  only.
- Clearing the visible chat transcript does not clear Floki's memories,
  personality, emotions, beliefs, relationships, private thoughts, or dreams.
