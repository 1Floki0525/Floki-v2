# Floki-v2 Frontal JSON Retry

The retry path now uses Ollama schema-constrained JSON.

It does not create deterministic cognition success.

If the primary model response fails JSON parsing or schema validation, frontal retries once with a smaller prompt and the same schema.

If the retry also fails, frontal returns an honest failure output.

Required fields in a valid cognition pass:

- normalized_model_json: true
- schema_constrained_json: true
- model_json_fallback_used: false
