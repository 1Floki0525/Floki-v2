# Floki-v2 Core Brain Module Rules

Every new module must follow this path:

1. Add the module implementation folder.
2. Expose a production module contract.
3. Register a factory in core_brain MODULE_REGISTRY.
4. Enable it only in the correct YAML config.
5. Add a module-specific proof.
6. Prove core_brain health still passes.

## Brain modules

Required brain modules must expose:

- module
- contract
- production=true contract
- machine-checkable inputs/outputs/state/failure modes

Current required chat brain modules:

- thalamus
- temporal
- amygdala
- emotions_base
- hippocampus
- personality
- pineal
- frontal
- broca

## Boundary modules

Boundary modules may be thinner than full brain modules when they are only declaring an external scope.

Current boundary module:

- chat_world_senses

It is chat-world only.

## Optional future modules

Known but disabled until real implementation exists:

- chat_world_vision
- chat_world_hearing
- game_world_eyes
- game_world_body

They may exist in YAML while disabled. They may not be enabled until MODULE_REGISTRY has a real factory and proof.
