# Floki-v2 Core Brain Model Selection

Model selection lives in YAML.

Chat mode reads:

config/chat.config.yaml

Game mode reads:

config/game.config.yaml

Current defaults:

- cognition: qwen3.5:9b
- vision: qwen3-vl:4b

The core_brain validator does not hard-lock those model names. It validates that model values are non-empty and loaded from YAML/env resolution.

This lets the project change models later without editing brain code.

Current env override keys:

- FLOKI_COGNITION_MODEL
- FLOKI_COGNITION_ENDPOINT
- FLOKI_VISION_MODEL
- FLOKI_VISION_ENDPOINT

Current stage remains guarded:

- Minecraft disabled
- game-world eyes disabled
- body movement disabled
- qwen-vl live vision disabled
