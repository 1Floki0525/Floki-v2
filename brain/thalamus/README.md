# Floki-v2 Thalamus

Stage: production foundation module.

The thalamus is the provenance-preserving event router for Floki-v2.

It receives validated brain events and produces route outputs telling the rest of the brain which modules should process the event next.

## Real responsibility

The thalamus routes events. It does not think for the other modules.

It preserves:

- event id
- event type
- event source
- modality
- timestamp
- parent event ids
- trace id
- observer
- confidence
- content fingerprint

## Inputs

- Floki-v2 brain event from `src/brain/brain-event-schema.cjs`
- optional route options:
  - `route_override`
  - `route_reason`
  - `persist_diagnostics`
  - `diagnostics_path`

## Outputs

- `route` brain output from `src/brain/brain-output-schema.cjs`
- `failure` brain output if the route is invalid or unsafe

## State reads

Current stage: none.

The thalamus is table-driven during the foundation stage.

## State writes

- `state/floki/diagnostics.jsonl`

Diagnostics are append-only.

## Diagnostics

- `route_created`
- `route_failed`
- `route_events_complete`

## Failure modes

- `THALAMUS_INVALID_EVENT`
- `THALAMUS_NO_TARGETS`
- `THALAMUS_UNSAFE_ROUTE_OVERRIDE`
- `THALAMUS_DIAGNOSTIC_WRITE_FAILED`

## Forbidden behavior

The thalamus must never:

- speak directly
- call the YAML-configured model
- call the YAML-configured model
- expose hidden reasoning
- store raw hidden reasoning
- start Minecraft
- start PaperMC
- move a body
- fake success

Broca is the only module that may produce speech.
