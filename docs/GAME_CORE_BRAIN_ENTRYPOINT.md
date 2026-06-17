# Floki-v2 Game Core Brain Entrypoint

Game mode now loads through core_brain using:

config/game.config.yaml

This is still guarded.

It does not start Minecraft yet.

It does not enable body movement yet.

It does not enable game-world eyes yet.

It does not use USB camera as game-world eyes.

## Current game mode meaning

Game mode means future Minecraft incarnation.

Future eyes source:

Minecraft first-person view

Future body source:

Minecraft avatar/client body

## Current proof

npm run proof:game-entrypoint

This proves:

- bin/floki-start.sh game-smoke works
- bin/floki-start.sh status works
- game mode loads config/game.config.yaml
- core_brain is active
- Minecraft is still disabled
- body movement is still disabled
- game-world eyes are still disabled
