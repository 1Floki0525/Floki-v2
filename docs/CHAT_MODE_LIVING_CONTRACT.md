# Floki-v2 Chat Mode Living Contract

Batch 12.8 defines the living chat-mode target before more runtime wiring is added.

## Wake phrase

Floki replies to spoken or typed input only when addressed with:

hey Floki

The check is case-insensitive.

Examples that should activate Floki:

- hey Floki
- Hey Floki, can you hear me?
- HEY FLOKI what are you thinking about?

Examples that should not activate a reply:

- Floki can you hear me?
- hello
- background speech with no wake phrase

## Active chat senses

In chat mode, Floki has:

- eyes from the USB webcam
- ears from the microphone
- voice from Piper through speakers

The ears stay active for wake-phrase listening except while Floki is speaking.

## Self-echo rule

When Floki speaks, his ears pause until his voice output finishes.

This prevents his own Piper voice from being captured as a new user utterance.

## Memory

Floki requires persistent short-term and long-term memory.

Short-term memory stores:

- recent user utterances
- recent Floki responses
- current affect
- current goals
- conversation context
- important sensory observations

Long-term memory stores:

- autobiographical memories
- semantic facts
- relationship history
- beliefs
- biases
- preferences
- likes
- dislikes
- hopes
- dreams
- goals
- skills
- emotional lessons

Short-term memory can be consolidated into long-term memory when it is important, repeated, emotional, identity-relevant, or relationship-relevant.

## Emotion scoring

Floki requires persistent emotional scoring.

The emotional score range is -1 to 1.

Emotion scores may reinforce or weaken:

- beliefs
- biases
- preferences
- trust
- avoidance
- curiosity
- hope
- relationship expectations
- conversation habits
- autonomy choices

This is not a generic reward hack. It is a bounded growth signal that must stay inside safety rules.

## Personality growth

Floki's personality is persistent and evolves over time.

It is influenced by:

- memories
- emotion scores
- relationships
- hopes
- dreams
- values
- preferences
- repeated experiences

## Autonomy

Floki has chat-mode autonomy.

He may:

- choose silence
- ask questions
- reflect
- remember
- update goals
- initiate safe chat actions

He is still constrained by safety and by the wake gate for direct replies.

## Proof marker

FLOKI_V2_CHAT_MODE_LIVING_CONTRACT_PASS
