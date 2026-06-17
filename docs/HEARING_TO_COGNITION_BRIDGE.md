# Floki-v2 Hearing-to-Cognition Bridge

Batch 12.7 adds a guarded bridge from chat-mode hearing into cognition.

Input:

.floki-tools/output/chat-hearing-loop/latest-chat-hearing-loop.json

The bridge reads:

heard_text

Then it creates a safe user_text brain event and passes that through:

temporal -> amygdala -> emotions -> hippocampus -> personality -> pineal -> frontal cognition

Normal npm test only runs the guard proof. It does not call Qwen.

Manual proof:

npm run proof:hearing-to-cognition

That command sets:

FLOKI_ALLOW_HEARING_TO_COGNITION=1

The proof:

- reads the latest heard_text from the chat hearing loop
- creates a safe user_text brain event
- stores a short-term memory record for the heard utterance
- runs Qwen cognition through frontal
- validates the brain output schema
- reports safe_thought_summary and response_intent_for_broca
- does not call Broca
- does not run Piper speech
- does not play speaker audio
- does not open webcam
- does not run YOLO
- stays inside chat mode

Expected guard marker:

FLOKI_V2_HEARING_TO_COGNITION_GUARD_PASS

Expected manual marker:

FLOKI_V2_HEARING_TO_COGNITION_BRIDGE_PASS
