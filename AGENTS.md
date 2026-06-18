# Floki-v2 Agents Guidelines

This repo is scaffold-only until production files are supplied.

## Agent Rules

Agents must use the repo Node runtime before running Node or npm commands:
`source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 24 >/dev/null`.
Do not run this repo's proofs, tests, scripts, or `node --check` with the
system `node` 22 binary.

Agents must not fill in production brain logic unless explicitly instructed.

Agents must not fake cognition, emotion, memory, vision, or body behavior.

Agents must preserve architecture boundaries.

Production implementation will be supplied file-by-file later.

## Scaffold Status

All brain modules are currently in scaffold mode with minimal placeholder implementations.

Stage marker: FLOKI_V2_STAGE_00_SCAFFOLD_ONLY_READY
