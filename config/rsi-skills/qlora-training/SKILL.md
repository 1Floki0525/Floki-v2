# QLoRA training

Run QLoRA training from the immutable HF master to a versioned candidate adapter.

## When to use
You are training a candidate adapter on the RTX 3060 12 GB.

## Pipeline
HF safetensors (immutable master) → QLoRA/LoRA → versioned candidate adapter → independent eval → Maker approval → merged HF checkpoint → GGUF export/quantize → versioned Ollama model → controlled activation with rollback.

## Rules
- QLoRA only (no full-weight 4B fine-tune). Never train the loaded Ollama GGUF.
- Preserve parent checkpoint identity, dataset hash, config, seed, adapter version, metrics, eval results, lineage, approval, activation, rollback target.
- All hyperparameters from YAML; the HF master directory is read-only.
