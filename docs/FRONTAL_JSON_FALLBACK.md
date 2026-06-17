# Floki-v2 Frontal JSON Fallback

Batch 12.12 hardens live chat cognition when Qwen returns malformed JSON.

Observed live failure:

FRONTAL_COGNITION_FAILED
model response was not parseable JSON

## Behavior

Frontal now does:

1. primary Qwen JSON request
2. one compact retry if the model returns malformed JSON
3. deterministic safe fallback if the retry also returns malformed JSON

The fallback is clearly marked:

- model_json_fallback_used
- model_json_fallback_reason
- json_retry_used
- json_retry_first_error

This is not hidden fake success. It is a safe recovery path so the chat loop can keep moving while still reporting that model JSON failed.

## Proof marker

FLOKI_V2_FRONTAL_JSON_FALLBACK_CONTRACT_PASS
