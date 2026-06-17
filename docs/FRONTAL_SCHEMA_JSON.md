# Floki-v2 Schema-Constrained Frontal JSON

Batch 12.13 removes deterministic cognition fallback and fixes the real issue.

## Problem

Qwen sometimes returned malformed JSON during live hearing-to-cognition.

The temporary fallback made the pipeline pass, but it did not prove real model JSON.

## Correct fix

The Ollama client now supports JSON schema objects in the Generate API format field.

Frontal now sends a strict cognition response schema to Ollama and validates the parsed response against the same schema.

## Behavior

Frontal now does:

1. primary schema-constrained model request
2. one schema-constrained retry if JSON parsing or schema validation fails
3. honest failure if the retry still fails

No deterministic cognition success is produced.

## Required proof

A valid live pass must show:

- normalized_model_json: true
- schema_constrained_json: true
- model_json_fallback_used: false
- cognition_type: model_response_summary

## Proof marker

FLOKI_V2_FRONTAL_SCHEMA_JSON_CONTRACT_PASS
