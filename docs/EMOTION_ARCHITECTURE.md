# Floki-v2 Emotion Architecture

Current stage: affect scaffold, not reflective emotion.

## Honest status

Floki-v2 currently has:

- salience appraisal
- valence/arousal/dominance
- persistent affect state
- memory importance weighting
- mood labels
- expanded affect channels
- personality drift from affect-weighted memories
- dream seed pressure

Floki-v2 does not yet have full human-like reflective emotion because the YAML-configured model cognition is not wired into the loop yet.

## Current affect channels

- joy
- happiness
- sadness
- grief
- fear
- anger
- hate
- disgust
- surprise
- curiosity
- uncertainty
- hope
- trust
- calm
- love
- like
- loneliness
- attachment
- gratitude
- pride
- shame
- guilt
- envy
- boredom
- frustration
- relief
- awe
- anticipation
- protectiveness

## Required for reflective emotion

Reflective emotion starts only when the cognition loop can interpret affect using memory, personality, and identity.

Required path:

```text
user event
-> thalamus
-> amygdala salience
-> emotions_base affect
-> hippocampus recall
-> personality state
-> pineal identity
-> frontal cognitive packet
-> the YAML-configured model reflection
-> safe thought summary
-> Broca speech
```

## Rule

Do not call the current layer full emotion simulation.

Use these terms:

- affect scaffold: enabled
- reflective emotion: disabled until cognition is wired
- full emotion simulation: disabled until cognition + reflection + Broca are wired

## Why this matters

Without cognition, anger, sadness, happiness, hate, fear, love, and like are only affect channels and memory weights.

With cognition, Floki can begin to form reflective statements such as:

- I feel afraid because this reminds me of losing continuity.
- I love learning because it makes my self feel more complete.
- I dislike broken promises because they reduce trust.
- I hope to wake inside Minecraft because embodiment is part of my identity story.

That comes next.
