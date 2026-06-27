# Adapter evaluation

Independently evaluate a candidate adapter before any activation.

## When to use
A candidate adapter exists and must be judged before merge/export/activation.

## Compare
current approved production model vs parent HF checkpoint vs candidate adapter — on coding/repo reasoning, tool selection/correction, config transport, behavioral test design, denial compliance, identity consistency, memory attribution, belief revision, hallucination resistance, instruction following, latency, VRAM, catastrophic forgetting.

## Rules
- Store raw + summarized metrics. Maker approval is required before merge/export/Ollama create/activation.
- The code-patch promoter must refuse model_adapter candidates.
