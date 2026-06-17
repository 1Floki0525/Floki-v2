# Floki-v2 Frontal JSON Retry

Batch 12.12 hardens live chat cognition against malformed model JSON.

Observed failure:

FRONTAL_COGNITION_FAILED
model response was not parseable JSON: Unterminated string in JSON

## Fix

Frontal now retries once when the model response fails JSON parsing.

The retry prompt is:

- shorter
- stricter
- JSON-only
- temperature 0
- top_p 0.1

## Report visibility

The hearing-to-cognition report now exposes:

- cognition_failure_code
- cognition_failure_message
- cognition_failure_recoverable
- json_retry_used
- json_retry_first_error

## Proof marker

FLOKI_V2_FRONTAL_JSON_RETRY_CONTRACT_PASS
