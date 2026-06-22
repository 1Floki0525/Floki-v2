# Floki Neural Interface

The Floki Neural Interface is the native Electron/React desktop client for Floki-v2 `chat.local` companion mode.

It is a client of the single authoritative Floki backend runtime. It does not create a second brain, second personality, second memory store, or separate spoken-chat identity.

## Launch

From the Floki-v2 repository root:

```bash
bin/floki-start.sh chat.local
```

Startup validates Node 24, the shared brain, and the sleep scheduler, then starts the backend with external eyes and ears suspended. The camera and microphone are released only after the Electron window is ready and visible and only when Floki is awake.

## Connected features

- typed and spoken conversation from one persistent transcript;
- visible transcript continuity across sessions;
- a clear-visible-chat control that preserves memories and private state;
- live webcam frame and observation status;
- person and object detections;
- cognition latency information;
- persistent affect and emotion state;
- awake, sleep, REM, and dream status;
- safe diagnostics and service controls.

## Authority boundaries

- Floki-v2 YAML owns adjustable runtime configuration and model identity.
- The backend runtime owns the brain, hearing, vision, memory, sleep lifecycle, and transcript files.
- Electron owns presentation and user interaction only.
- Clearing the visible chat transcript does not clear Floki's memories, personality, emotions, beliefs, relationships, private thoughts, or dreams.
