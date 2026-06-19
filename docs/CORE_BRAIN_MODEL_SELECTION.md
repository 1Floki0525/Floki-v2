# Floki-v2 Core Brain Model Selection

Model selection lives in YAML.

Chat mode reads:

config/chat.config.yaml

Game mode reads:

config/game.config.yaml

Current defaults:

- cognition: the YAML-configured model
- vision: the YAML-configured model

The core_brain validator does not hard-lock those model names. It validates that model values are non-empty and loaded from YAML/env resolution.

This lets the project change models later without editing brain code.

Current env override keys:

- models.cognition.model
- FLOKI_COGNITION_ENDPOINT
- models.vision.model
- FLOKI_VISION_ENDPOINT

Current stage remains guarded:

- Minecraft disabled
- game-world eyes disabled
- body movement disabled
- qwen-vl live vision disabled
