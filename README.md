# Floki-v2

Floki-v2 is a local-first personal AI companion and digital-being project.

The project is designed around one persistent individual named **Floki** rather than a disposable chatbot session. Floki is intended to maintain a continuous identity, personality, emotional state, memories, beliefs, relationships, sensory experience, sleep cycle, and dreams across conversations and restarts.

## Purpose

Floki-v2 has one main operating mode:

### `chat.local` — personal AI companion

`chat.local` runs Floki as a private desktop companion through the Floki Neural Interface.

While awake, the intended production workflow gives Floki:

- typed conversation;
- continuous microphone hearing;
- direct-address recognition through YAML-configured wake phrases;
- ambient awareness of nearby speech, television, music, animals, alarms, doors, and other meaningful room sounds;
- live webcam sight;
- current person and object detections;
- local cognition through Ollama;
- local Whisper transcription;
- local Silero VAD speech detection;
- local Piper speech output;
- persistent conversation history;
- persistent memories, emotions, personality, beliefs, and relationships;
- a configured sleep, REM, consolidation, and dream cycle.

Typed and spoken input are required to use the same authoritative long-lived brain and memory state. Camera and microphone services are lifecycle-controlled and should only become active after the desktop interface is ready and Floki is awake.

Start the local companion with:

```bash
floki.app
```

## Architecture overview

The brain is organized as cooperating modules inspired by functional brain regions:

- `brain/core_brain` — authoritative orchestration and shared identity;
- `brain/thalamus` — sensory and event routing;
- `brain/temporal` — language and contextual interpretation;
- `brain/amygdala` and `brain/emotions_base` — affect and emotional influence;
- `brain/hippocampus` — memory encoding and recall;
- `brain/personality` — persistent personality and identity expression;
- `brain/pineal` — inner imagery, reflection, and dream-related processing;
- `brain/frontal` — cognition and response planning;
- `brain/broca` — public language and spoken-response shaping.

The production `chat.local` workflow is centered on:

```text
Floki Neural Interface
        ↓
authoritative chat.local runtime
        ├── one persistent core brain
        ├── typed-input path
        ├── continuous hearing path
        ├── live vision path
        ├── transcript and memory persistence
        ├── Piper speech output
        └── sleep / REM / dream lifecycle
```

## Configuration

The public repository tracks sanitized configuration templates:

```text
config/chat.config.yaml.temp
```

Create private working copies after cloning:

```bash
cp config/chat.config.yaml.temp config/chat.config.yaml
```

The working `config/chat.config.yaml` files are ignored by Git so personal paths and machine-specific settings are not published. Floki still loads those working files at runtime through the existing configuration layer.

The lightweight YAML parser is map-only. Use keyed maps instead of YAML arrays. Production source must not hardcode adjustable values such as model names, ports, device paths, wake phrases, timing values, thresholds, sleep schedules, speech settings, or personal storage paths.

For public YouTube transcript ingestion, configure `paths.youtube_cookies_file` only in the local chat YAML. See [Knowledge Ingestion](docs/KNOWLEDGE_INGESTION.md) for cookie safety, yt-dlp setup, output locations, and scraper behavior.

## Knowledge ingestion

Floki can turn subtitle data from public, non-live YouTube videos into local text knowledge without downloading video or audio. Members-only, private, restricted, unavailable, and live content is skipped. Full setup and safety guidance is in [docs/KNOWLEDGE_INGESTION.md](docs/KNOWLEDGE_INGESTION.md).

## Runtime and development commands

Load Node 24 before development work:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24
node -v
```

Build the Electron/Vite neural interface and run its integration tests without starting the live runtime:

```bash
npm run build
```

Run the full project test suite:

```bash
npm test
```

Check the running companion workflow:

```bash
bash bin/floki-chat-status.sh
```

Stop the local companion workflow:

```bash
bash bin/floki-chat-stop.sh
```

## Current development status

Floki-v2 is an active implementation, not a scaffold-only repository.

The repository currently contains real brain modules, persistent memory and affect systems, local cognition, live microphone and vision services, local speech output, the Electron/React Neural Interface, sleep scheduling, REM state, dream generation, and extensive contract tests.

The `chat.local` workflow is still being stabilized for production-quality conversational latency, complete spoken-utterance capture, truthful live sensory answers, transcript continuity, lifecycle ordering, and clean service recovery. Static tests do not replace live verification with the real microphone, camera, local models, speaker, and desktop interface.

## Repository boundaries

- Runtime-generated state belongs under `state/` and is not source code.
- Model weights, virtual environments, build output, raw audio, and temporary camera frames should not be committed.
- Minecraft or other game-specific embodiment must not be introduced into `chat.local` unless a shared abstraction explicitly requires it.
- Personal memories and private runtime data must not be published with the source repository.

## License

MIT
