# Nightly GPU scheduling

Coordinate nightly training with REM cycles and GPU ownership exclusivity.

## When to use
You are integrating training with the nightly sleep/REM scheduler.

## Facts
- Night sleep 23:00–07:00 America/Toronto; REM every 10 min; 47 nightly cycles (+10..+470), none at the 07:00 boundary.
- Manual nap: 30 min, REM at +10 and +20, wake at +30.

## Rules
- Automatic training begins only at the real nightly sleep transition (never daytime naps).
- Before each due REM: checkpoint training, release GPU, load HF for REM inference, write dream + index, unload, resume next segment.
- Nightly REM uses the Hugging Face checkpoint/approved lineage (never Ollama); manual nap REM uses Ollama.
- One GPU owner at a time via an explicit lock; preserve exactly-once cycle claiming across resume.
