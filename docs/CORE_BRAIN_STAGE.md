# Floki-v2 Core Brain Stage

The core_brain owns the module graph.

Chat mode loads:

config/chat.config.yaml

Game mode loads:

config/game.config.yaml

Model selection also lives in those YAML files.

## Registry rule

A module may exist in YAML while disabled.

A module may only be enabled when core_brain has a registered factory for it.

This prevents optional modules like chat-world vision, hearing, game-world eyes, or game-world body from breaking chat/foundation before their implementation exists.

Current registered factories:

- thalamus
- temporal
- amygdala
- emotions_base
- hippocampus
- personality
- pineal
- frontal
- broca
- chat_world_senses

Known but not registered yet:

- chat_world_vision
- chat_world_hearing
- game_world_eyes
- game_world_body

## Mode split

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
