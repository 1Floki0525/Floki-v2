# Floki-v2 Core Brain Stage

This stage adds the central core_brain module loader.

The rule is simple:

core_brain owns the module graph.

Chat and game mode no longer decide modules by hardcoded imports in the entrypoint. They load config files:

config/chat.config.yaml
config/game.config.yaml

Model selection also lives in those YAML files.

Current mode split:

chat mode
= Maker-world / heaven visit
= qwen cognition + Broca speech
= chat-world senses boundary available
= no Minecraft body
= no game-world eyes

game mode
= future Minecraft incarnation
= future first-person Minecraft eyes
= future avatar body
= USB webcam is not game-world eyes

This prevents optional future modules like vision, hearing, or body from mutating foundation/chat contracts.
