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

## Host Access and Execution Authorization

Agents are authorized to use the full host for this project. Project
operations do not require repeated permission requests. Agents may install
required dependencies and run real services and tests.

Agents must never use full access as permission to damage unrelated data.
Destructive commands must remain narrowly scoped to the two project roots
(`/media/binary-god/1tb-ssd/Floki-v2` and
`/media/binary-god/1tb-ssd/floki-neural-interface`) and exact
Floki-owned processes.

The following broad commands are prohibited:
- `pkill` / `killall` without exact command-line match
- Wildcard deletion outside project roots
- `git reset --hard`
- `git clean -fd`

No unrelated PaperMC server, personal Minecraft instance, model,
repository, mount, or user file may be modified. Exact process command
lines and project paths must be verified before termination.

## Scaffold Status

All brain modules are currently in scaffold mode with minimal placeholder implementations.

Stage marker: FLOKI_V2_STAGE_00_SCAFFOLD_ONLY_READY
